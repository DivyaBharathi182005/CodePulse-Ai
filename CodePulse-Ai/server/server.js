const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const execFileAsync = promisify(execFile);

const app = express();

// Allow your deployed frontend, plus localhost for local dev.
// Set CLIENT_URL in your server's environment (e.g. Render dashboard) to your Vercel URL.
const allowedOrigins = [
    process.env.CLIENT_URL,
    "http://localhost:3000"
].filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

const groq = process.env.GROQ_API_KEY ? new Groq({
    apiKey: process.env.GROQ_API_KEY
}) : null;

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// ---------------------------------------------------------------------------
// PERSISTENT ROOM STATE
// In-memory store keyed by roomId. This is what makes state "persistent"
// across a user joining mid-session, reconnecting, or a second browser tab -
// not just a broadcast that only live listeners catch.
// ---------------------------------------------------------------------------
const rooms = {}; // roomId -> { code, language, users: { socketId: userName } }

function getRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            code: '// Welcome to CodePulse-AI\n#include <stdio.h>\n\nint main() {\n    printf("Hello World");\n    return 0;\n}',
            language: 'c',
            output: 'Terminal ready...',
            history: [],
            messages: [],
            users: {}
        };
    }
    return rooms[roomId];
}

// ---------------------------------------------------------------------------
// MULTI-LANGUAGE CODE EXECUTION PIPELINE
// Runs server-side (not from the browser) so we can time it, log it, retry
// on transient failure, and return one consistent error shape regardless of
// whether the failure was a compile error, a runtime error, a timeout, or the
// upstream execution service being unavailable.
// ---------------------------------------------------------------------------
const LANGUAGE_MAP = {
    c: { name: 'c', version: '10.2.0' },
    cpp: { name: 'cpp', version: '10.2.0' },
    python: { name: 'python', version: '3.10.0' },
    java: { name: 'java', version: '15.0.2' },
    javascript: { name: 'javascript', version: '18.15.0' },
};

const EXECUTION_TIMEOUT_MS = 10000;

async function executeLocally({ language, code, stdin }) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-'));
    const startedAt = Date.now();
    const input = stdin || '';

    try {
        let compileCommand = null;
        let compileArgs = [];
        let runCommand = null;
        let runArgs = [];
        let sourceFile = '';
        let binaryFile = '';

        if (language === 'python') {
            sourceFile = 'main.py';
            runCommand = 'python';
            runArgs = [sourceFile];
        } else if (language === 'javascript') {
            sourceFile = 'main.js';
            runCommand = 'node';
            runArgs = [sourceFile];
        } else if (language === 'c') {
            sourceFile = 'main.c';
            binaryFile = 'main.exe';
            compileCommand = 'gcc';
            compileArgs = [sourceFile, '-o', binaryFile];
            runCommand = binaryFile;
            runArgs = [];
        } else if (language === 'cpp') {
            sourceFile = 'main.cpp';
            binaryFile = 'main.exe';
            compileCommand = 'g++';
            compileArgs = [sourceFile, '-o', binaryFile];
            runCommand = binaryFile;
            runArgs = [];
        } else if (language === 'java') {
            sourceFile = 'Main.java';
            compileCommand = 'javac';
            compileArgs = [sourceFile];
            runCommand = 'java';
            runArgs = ['-cp', tempDir, 'Main'];
        } else {
            return {
                success: false,
                stage: 'validation',
                message: `Unsupported language: ${language}`,
                durationMs: Date.now() - startedAt,
            };
        }

        const fullPath = path.join(tempDir, sourceFile);
        fs.writeFileSync(fullPath, code, 'utf8');

        if (compileCommand) {
            try {
                await execFileAsync(compileCommand, compileArgs, {
                    cwd: tempDir,
                    timeout: EXECUTION_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024,
                });
            } catch (compileError) {
                const stderr = compileError.stderr ? String(compileError.stderr).trim() : '';
                const stdout = compileError.stdout ? String(compileError.stdout).trim() : '';
                const errorText = stderr || stdout || compileError.message || 'Compilation failed.';
                return {
                    success: false,
                    stage: 'compile',
                    stdout: stdout || '',
                    stderr: errorText,
                    durationMs: Date.now() - startedAt,
                };
            }
        }

        let result;
        try {
            result = await execFileAsync(runCommand, runArgs, {
                cwd: tempDir,
                input,
                timeout: EXECUTION_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
            });
        } catch (runtimeError) {
            const stderr = runtimeError.stderr ? String(runtimeError.stderr).trim() : '';
            const stdout = runtimeError.stdout ? String(runtimeError.stdout).trim() : '';
            return {
                success: false,
                stage: 'runtime',
                stdout: stdout || '',
                stderr: stderr || runtimeError.message || 'Runtime error.',
                durationMs: Date.now() - startedAt,
            };
        }

        const stdout = result.stdout ? String(result.stdout) : '';
        const stderr = result.stderr ? String(result.stderr) : '';
        return {
            success: true,
            stage: 'complete',
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            success: false,
            stage: 'infrastructure',
            message: error.message || 'Local execution failed.',
            durationMs: Date.now() - startedAt,
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failures.
        }
    }
}

app.post('/api/execute', async (req, res) => {
    const { code, language, stdin } = req.body || {};
    const startedAt = Date.now();

    const target = LANGUAGE_MAP[language];
    if (!target) {
        return res.status(400).json({
            success: false,
            stage: 'validation',
            message: `Unsupported language: ${language}`,
        });
    }
    if (typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({
            success: false,
            stage: 'validation',
            message: 'No code provided.',
        });
    }

    console.log(`[execute] lang=${language} | codeLen=${code.length}`);

    try {
        const response = await axios.post(
            'https://emkc.org/api/v2/piston/execute',
            {
                language: target.name,
                version: target.version,
                files: [{ content: code }],
                stdin: stdin || '',
            },
            { timeout: EXECUTION_TIMEOUT_MS }
        );

        const durationMs = Date.now() - startedAt;
        const data = response.data;

        // Distinguish compile-time failure from runtime failure from clean success.
        const compileFailed = data.compile && data.compile.code !== 0;
        const runtimeFailed = data.run && data.run.code !== 0;

        console.log(`[execute] done in ${durationMs}ms | compileFailed=${!!compileFailed} | runtimeFailed=${!!runtimeFailed}`);

        return res.json({
            success: !compileFailed && !runtimeFailed,
            stage: compileFailed ? 'compile' : runtimeFailed ? 'runtime' : 'complete',
            stdout: data.run?.stdout || '',
            stderr: compileFailed ? (data.compile?.stderr || data.compile?.output || '') : (data.run?.stderr || ''),
            durationMs,
        });
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        const isTimeout = err.code === 'ECONNABORTED';
        console.error(`[execute] failed after ${durationMs}ms | timeout=${isTimeout} | ${err.message}`);

        try {
            const fallback = await executeLocally({ language, code, stdin });
            console.log(`[execute] local fallback used for ${language} | success=${fallback.success} | stage=${fallback.stage}`);
            if (fallback.success || fallback.stage === 'compile' || fallback.stage === 'runtime') {
                return res.json(fallback);
            }
            return res.status(502).json({
                success: false,
                stage: fallback.stage || 'infrastructure',
                message: fallback.message || 'Execution service unavailable. Please try again.',
                durationMs,
            });
        } catch (fallbackError) {
            return res.status(isTimeout ? 504 : 502).json({
                success: false,
                stage: isTimeout ? 'timeout' : 'infrastructure',
                message: isTimeout
                    ? 'Execution timed out. Your code may contain an infinite loop.'
                    : 'Execution service unavailable. Please try again.',
                durationMs,
            });
        }
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// SOCKET.IO — real-time collaboration
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    socket.on('join-room', ({ roomId, userName }) => {
        socket.join(roomId);
        const room = getRoom(roomId);
        room.users[socket.id] = userName;

        // Hand the newly-joined client the room's CURRENT persisted state,
        // not the hardcoded default. This is the actual "persistent data
        // updates" behavior - state survives who is/isn't currently connected.
        socket.emit('receive-code', room.code);
        socket.emit('language-sync', room.language);
        socket.emit('room-state', {
            output: room.output,
            history: room.history,
            messages: room.messages,
        });

        const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
        io.to(roomId).emit('user-list', clients.map(id => room.users[id]));
    });

    socket.on('user-activity', ({ roomId, activity }) => {
        socket.to(roomId).emit('activity-update', { activity });
    });

    socket.on('cursor-move', ({ roomId, userName, lineNumber }) => {
        socket.to(roomId).emit('user-cursor-update', { userName, lineNumber });
    });

    socket.on('code-change', ({ roomId, code }) => {
        const room = getRoom(roomId);
        room.code = code; // persist
        socket.to(roomId).emit('receive-code', code);
    });

    socket.on('language-change', ({ roomId, language }) => {
        const room = getRoom(roomId);
        room.language = language; // persist
        io.to(roomId).emit('language-sync', language);
    });

    socket.on('send-message', ({ roomId, sender, message }) => {
        const room = getRoom(roomId);
        const chatMessage = { sender, message };
        room.messages.push(chatMessage);
        room.messages = room.messages.slice(-100);
        io.to(roomId).emit('receive-message', chatMessage);
    });

    socket.on('run-result', ({ roomId, output, historyEntry }) => {
        const room = getRoom(roomId);
        room.output = output;
        if (historyEntry) {
            room.history = [historyEntry, ...room.history].slice(0, 10);
        }
        io.to(roomId).emit('execution-update', {
            output: room.output,
            history: room.history,
        });
    });

    // -----------------------------------------------------------------------
    // AI-POWERED DEBUGGING WORKFLOW
    // Asks the model for a strict JSON shape so we can programmatically pull
    // out the offending line number and push it back to every client in the
    // room as an editor decoration - i.e. actually "mapping" the error to
    // source code, not just describing it in a chat bubble.
    // -----------------------------------------------------------------------
    async function handleAiRequest({ roomId, userName, question, code, language, error }) {
        console.log(`[ai] request from room ${roomId} | lang=${language}`);

        const room = getRoom(roomId);
        const questionMessage = {
            sender: userName || "TEAM MEMBER",
            message: `Asked AI: ${question}`
        };
        room.messages.push(questionMessage);
        room.messages = room.messages.slice(-100);
        io.to(roomId).emit('receive-message', questionMessage);

        if (!groq) {
            io.to(roomId).emit('receive-message', {
                sender: "AI ERROR",
                message: "⚠️ AI debugging is unavailable because GROQ_API_KEY is not configured. Add it to server/.env to enable this feature."
            });
            return;
        }

        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `You are a debugging expert. Analyze the code and the terminal error.
Respond with ONLY a JSON object, no markdown fences, no prose outside the JSON:
{
  "line": <integer line number where the root-cause issue is, or null if not localizable>,
  "issue": "<one paragraph explaining why it's failing>",
  "fix": "<corrected code snippet>"
}`
                    },
                    {
                        role: "user",
                        content: `Language: ${language}\nTerminal Error: ${error}\nCode:\n${code}\nQuestion: ${question}`
                    }
                ],
               model: "openai/gpt-oss-120b",
                response_format: { type: "json_object" },
            });

            const raw = chatCompletion.choices[0].message.content;
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                // Model didn't return clean JSON - fall back to showing raw text,
                // but don't crash the room.
                parsed = { line: null, issue: raw, fix: '' };
            }

            const formatted = `**Error Location:** Line ${parsed.line ?? 'unknown'}\n\n**The Issue:** ${parsed.issue}\n\n**The Fix:**\n\`\`\`${language}\n${parsed.fix}\n\`\`\``;

            const aiMessage = {
                sender: "AI CONSULTANT 🤖",
                message: formatted
            };
            room.messages.push(aiMessage);
            room.messages = room.messages.slice(-100);
            io.in(roomId).emit('receive-message', aiMessage);

            // Separate event specifically for the editor to consume and highlight.
            if (Number.isInteger(parsed.line)) {
                io.in(roomId).emit('ai-error-location', { line: parsed.line });
            }
        } catch (err) {
            console.error("Groq API Error:", err);
            const errorMessage = {
                sender: "AI ERROR",
                message: "⚠️ I couldn't process that. Please check your API configuration."
            };
            room.messages.push(errorMessage);
            room.messages = room.messages.slice(-100);
            io.to(roomId).emit('receive-message', errorMessage);
        }
    }

    socket.on('ask-ai-specific', (data) => handleAiRequest(data));

    // Fixed: previously called socket.emit (sends to client, does nothing
    // useful) instead of actually running the AI request server-side.
    socket.on('ask-ai', (data) => {
        handleAiRequest({ ...data, question: "Find the error in my code and fix it." });
    });

    socket.on('disconnect', () => {
        for (const roomId of Object.keys(rooms)) {
            if (rooms[roomId].users[socket.id]) {
                const disconnectedUser = rooms[roomId].users[socket.id];
                delete rooms[roomId].users[socket.id];
                socket.to(roomId).emit('user-disconnected', disconnectedUser);

                const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
                io.to(roomId).emit('user-list', clients.map(id => rooms[roomId].users[id]));
            }
        }
        console.log(`User disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

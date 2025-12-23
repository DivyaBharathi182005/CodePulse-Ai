const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Groq } = require('groq-sdk');
require('dotenv').config(); // Load variables at the very beginning

const app = express();
app.use(cors());

// Initialize Groq using the environment variable
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY 
});

const server = http.createServer(app);

// Initialize Socket.io
// Inside server.js
const io = new Server(server, {
    cors: { 
        origin: "https://codepulse-ai-theta.vercel.app", 
        methods: ["GET", "POST"],
        credentials: true
    }
});

let users = {};

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    // 1. User Joins
    socket.on('join-room', ({ roomId, userName }) => {
        socket.join(roomId);
        users[socket.id] = userName;
        const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
        io.to(roomId).emit('user-list', clients.map(id => users[id]));
    });

    socket.on('user-activity', ({ roomId, activity }) => {
        socket.to(roomId).emit('activity-update', { activity });
    });

    socket.on('cursor-move', ({ roomId, userName, lineNumber }) => {
        socket.to(roomId).emit('user-cursor-update', { userName, lineNumber });
    });

    // 2. Code Sync Logic
    socket.on('code-change', ({ roomId, code }) => {
        socket.to(roomId).emit('receive-code', code);
    });

    // 3. Team Chat Logic
    socket.on('send-message', ({ roomId, sender, message }) => {
        socket.to(roomId).emit('receive-message', { sender, message });
    });

    // 4. AI LOGIC (Handles specific questions)
    socket.on('ask-ai-specific', async ({ roomId, question, code, language, error }) => {
        console.log(`AI request from room: ${roomId}`);
        
        try {
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `You are a Debugging Expert. 
                        Analyze the code and pinpoint the exact line of the error.
                        Format: 
                        1. **Error Location**: [Line Number]
                        2. **The Issue**: [Explain why it's failing]
                        3. **The Fix**: [Provide the corrected code snippet]`
                    },
                    {
                        role: "user",
                        content: `Language: ${language}\nTerminal Error: ${error}\nCode:\n${code}\nQuestion: ${question}`
                    }
                ],
                model: "llama-3.3-70b-versatile", 
            });

            const aiMessage = chatCompletion.choices[0].message.content;

            io.to(roomId).emit('receive-message', {
                sender: "AI CONSULTANT 🤖",
                message: aiMessage
            });
        } catch (err) {
            console.error("Groq API Error:", err);
            io.to(roomId).emit('receive-message', {
                sender: "AI ERROR",
                message: "⚠️ I couldn't process that. Please check your API configuration."
            });
        }
    });

    // 5. AI FIX Shortcut
    socket.on('ask-ai', async (data) => {
        // Redirects to the specific logic with a default prompt
        socket.emit('ask-ai-specific', { 
            ...data,
            question: "Find the error in my code and fix it."
        });
    });

    // 6. Handle Disconnect
    socket.on('disconnect', () => {
        delete users[socket.id];
        console.log(`User disconnected: ${socket.id}`);
    });
});

// Use dynamic port for deployment (Render/Railway)
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));




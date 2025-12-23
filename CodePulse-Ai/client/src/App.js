import React, { useEffect, useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import './index.css';
import { io } from 'socket.io-client';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from "jspdf";
import "jspdf-autotable";
import { Trash2, Monitor, Download, X, Pencil, Eraser, Send, Moon, Sun, Sparkles, Play, Activity } from 'lucide-react';
import './App.css'; 

const socket = io(process.env.REACT_APP_SERVER_URL || "https://codepulse-ai-oavp.onrender.com");const roomId = "cse-project-room";

function App() {
    // --- ALL ORIGINAL STATES PRESERVED ---
    const [userName, setUserName] = useState('');
    const [isJoined, setIsJoined] = useState(false);
    const [code, setCode] = useState('// Welcome to CodePulse-AI\n#include <stdio.h>\n\nint main() {\n    printf("Hello World");\n    return 0;\n}');
    const [language, setLanguage] = useState('c');
    const [userInput, setUserInput] = useState('');
    const [output, setOutput] = useState('Terminal ready...');
    const [messages, setMessages] = useState([]);
    const [msgInput, setMsgInput] = useState('');
    const [onlineUsers, setOnlineUsers] = useState([]);
    const [isRunning, setIsRunning] = useState(false);
    const [theme, setTheme] = useState('vs-dark');
    const [history, setHistory] = useState([]);
    const [showBoard, setShowBoard] = useState(false);
    const [isDrawing, setIsDrawing] = useState(false);
    const [brushColor, setBrushColor] = useState('#000000');
    const [activity, setActivity] = useState('System Idle');

    // --- NEW STATES FOR CURSOR HIGHLIGHTING ---
    const [userCursors, setUserCursors] = useState({}); 
    const editorRef = useRef(null);
    const monacoRef = useRef(null);
    const decorationsRef = useRef([]);
    const canvasRef = useRef(null);
    const chatEndRef = useRef(null);

    // --- 1. NEW: EDITOR MOUNT & HIGHLIGHT LOGIC ---
    const handleEditorDidMount = (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        
        // Listen for local cursor changes and tell others
        editor.onDidChangeCursorPosition((e) => {
            const lineNumber = e.position.lineNumber;
            socket.emit('cursor-move', { roomId, userName, lineNumber });
        });
    };

    // Apply Highlights Effect
    useEffect(() => {
        if (!editorRef.current || !monacoRef.current || !isJoined) return;

        const newDecorations = Object.entries(userCursors).map(([name, line]) => ({
            range: new monacoRef.current.Range(line, 1, line, 1),
            options: {
                isWholeLine: true,
                className: 'remote-cursor-line',
                glyphMarginClassName: 'remote-cursor-glyph',
                hoverMessage: { value: `User: ${name} is here` }
            }
        }));

        decorationsRef.current = editorRef.current.deltaDecorations(
            decorationsRef.current, 
            newDecorations
        );
    }, [userCursors]);

    // --- 2. GLOBAL ACTIVITY EMISSION (PRESERVED) ---
    useEffect(() => {
        if (!isJoined) return;
        const currentActivity = `${userName} is typing in ${language.toUpperCase()}...`;
        socket.emit('user-activity', { roomId, activity: currentActivity });
        setActivity(currentActivity);

        const timer = setTimeout(() => {
            socket.emit('user-activity', { roomId, activity: 'System Idle' });
            setActivity('System Idle');
        }, 3000);
        return () => clearTimeout(timer);
    }, [code]);

    useEffect(() => {
        if (!isJoined) return;
        const langMsg = `${userName} switched to ${language.toUpperCase()}`;
        socket.emit('user-activity', { roomId, activity: langMsg });
        setActivity(langMsg);
    }, [language]);

    // --- 3. LOGIN LOGIC (PRESERVED) ---
    const handleLogin = (e) => {
        e.preventDefault();
        if (userName.trim()) {
            setIsJoined(true);
            socket.emit('join-room', { roomId, userName });
        }
    };

    // --- 4. EXECUTION LOGIC (PRESERVED) ---
    const handleRunCode = async () => {
        setIsRunning(true);
        const runMsg = `${userName} is Running Code...`;
        socket.emit('user-activity', { roomId, activity: runMsg });
        setActivity(runMsg);

        setOutput("Compiling & Running...");
        const timestamp = new Date().toLocaleTimeString();
        setHistory(prev => [{ time: timestamp, lang: language, savedCode: code }, ...prev].slice(0, 10));

        const languageMap = {
            'c': { name: 'c', version: '10.2.0' },
            'cpp': { name: 'cpp', version: '10.2.0' },
            'python': { name: 'python', version: '3.10.0' },
            'java': { name: 'java', version: '15.0.2' }
        };

        try {
            const response = await fetch("https://emkc.org/api/v2/piston/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    language: languageMap[language].name,
                    version: languageMap[language].version,
                    files: [{ content: code }],
                    stdin: userInput,
                }),
            });
            const data = await response.json();
            if (data.run) {
                const result = data.run.stderr ? `${data.run.stderr}\n${data.run.stdout}` : data.run.stdout;
                setOutput(result || "Code executed successfully.");
                socket.emit('user-activity', { roomId, activity: `${userName} finished execution` });
            }
        } catch (error) {
            setOutput("Error: Connection failed.");
        } finally {
            setIsRunning(false);
        }
    };

    // --- 5. AI LOGIC (PRESERVED) ---
    const handleAiFix = () => {
        if (!output || output === 'Terminal ready...') return alert("Run code first!");
        setMessages(prev => [...prev, { sender: "SYSTEM", message: "*AI is analyzing for " + userName + "...*" }]);
        socket.emit('ask-ai-specific', { roomId, question: "Fix my code", code, language, error: output });
    };

    const askQuestion = (e) => {
        e.preventDefault();
        const query = e.target.aiQuery?.value || ""; 
        if (!query.trim()) return;
        socket.emit('ask-ai-specific', { roomId, question: query, code, language, error: output });
        e.target.reset(); 
    };

    // --- 6. MESSAGING & EXPORT (PRESERVED) ---
    const sendMessage = (e) => {
        e.preventDefault();
        if (msgInput.trim()) {
            socket.emit('send-message', { roomId, message: msgInput, sender: userName });
            setMessages(prev => [...prev, { sender: userName, message: msgInput }]);
            setMsgInput('');
        }
    };

    const handleSaveFile = (type) => {
        const timestamp = new Date().toLocaleString();
        if (type === 'pdf') {
            const doc = new jsPDF();
            doc.setFont("helvetica", "bold");
            doc.text("PROJECT REPORT", 105, 20, { align: "center" });
            doc.setFontSize(10);
            doc.text(`User: ${userName} | Lang: ${language} | Date: ${timestamp}`, 14, 30);
            doc.text("CODE:", 14, 45);
            doc.setFont("courier", "normal");
            doc.text(code, 14, 55);
            doc.save(`Project_Report.pdf`);
        } else {
            const blob = new Blob([code], { type: "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `code.${type === 'word' ? 'doc' : 'txt'}`;
            a.click();
        }
    };

    // --- 7. WHITEBOARD & SOCKET EFFECTS (PRESERVED) ---
    const draw = (e) => {
        if (!isDrawing) return;
        const ctx = canvasRef.current.getContext('2d');
        const rect = canvasRef.current.getBoundingClientRect();
        ctx.strokeStyle = brushColor;
        ctx.lineWidth = 3;
        ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
        ctx.stroke();
    };

    useEffect(() => {
        if (!isJoined) return;
        socket.on('receive-message', (msg) => setMessages(prev => [...prev, msg]));
        socket.on('receive-code', (newCode) => setCode(newCode));
        socket.on('user-list', (list) => setOnlineUsers(list));
        socket.on('activity-update', (data) => setActivity(data.activity));
        
        // Listen for team cursors
        socket.on('user-cursor-update', ({ userName: remoteUser, lineNumber }) => {
            if (remoteUser !== userName) {
                setUserCursors(prev => ({ ...prev, [remoteUser]: lineNumber }));
            }
        });

        return () => {
            socket.off('receive-message'); socket.off('receive-code');
            socket.off('user-list'); socket.off('activity-update');
            socket.off('user-cursor-update');
        };
    }, [isJoined, userName]);

    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

    // --- UI RENDERING (ORIGINAL 400-LINE LAYOUT) ---
    if (!isJoined) {
        return (
            <div className="login-screen" style={{ height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#1e1e1e' }}>
                <form onSubmit={handleLogin} style={{ background: '#2d2d2d', padding: '40px', borderRadius: '15px', textAlign: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
                    <h1 style={{ color: '#61dafb', marginBottom: '10px' }}>CodePulse-AI 🤖</h1>
                    <p style={{ color: '#888', marginBottom: '25px' }}>Collaborative Real-time Coding</p>
                    <input autoFocus value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Enter Your Name" 
                           style={{ padding: '12px', width: '280px', borderRadius: '4px', border: '1px solid #444', background: '#1e1e1e', color: 'white', marginBottom: '20px', outline: 'none' }} />
                    <button type="submit" style={{ display: 'block', width: '100%', padding: '12px', background: '#61dafb', fontWeight: 'bold', cursor: 'pointer', border: 'none', borderRadius: '4px' }}>Launch Workspace</button>
                </form>
            </div>
        );
    }

    return (
        <div className="app-container" style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: "#1e1e1e" }}>
            
            {/* 1. LEFT SIDEBAR */}
            <div className="left-sidebar" style={{ width: "230px", background: "#252526", borderRight: "1px solid #333", padding: "15px", display: 'flex', flexDirection: 'column', color: "white" }}>
                
                {/* BRAND LOGO AREA */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '25px', paddingBottom: '15px', borderBottom: '1px solid #333' }}>
                    <Activity size={20} color="#61dafb" />
                    <span style={{ fontWeight: '800', fontSize: '16px', color: 'white', letterSpacing: '1px' }}>
                        CODEPULSE <span style={{ color: '#61dafb' }}>AI</span>
                    </span>
                </div>

                {/* ONLINE TEAM SECTION */}
                <h6 style={{ color: '#888', marginBottom: '10px', fontSize: '11px', letterSpacing: '1px' }}>ONLINE TEAM</h6>
                <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px' }}>
                    {onlineUsers.map((u, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#4caf50', fontSize: '13px', marginBottom: '8px' }}>
                            <span style={{ fontSize: '10px' }}>●</span>
                            <span style={{ color: '#ccc' }}>{u}</span>
                        </div>
                    ))}
                </div>

                {/* HISTORY SECTION */}
                <h6 style={{ color: '#888', marginBottom: '10px', fontSize: '11px', letterSpacing: '1px' }}>HISTORY</h6>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {history.length > 0 ? (
                        history.map((h, i) => (
                            <div 
                                key={i} 
                                onClick={() => setCode(h.savedCode)} 
                                style={{ padding: '10px', background: '#333', fontSize: '11px', marginBottom: '8px', cursor: 'pointer', borderRadius: '6px', border: '1px solid #444' }}
                            >
                                <div style={{ color: '#61dafb', fontWeight: 'bold', marginBottom: '2px' }}>{h.lang.toUpperCase()}</div>
                                <div style={{ color: '#888', fontSize: '10px' }}>{h.time}</div>
                            </div>
                        ))
                    ) : (
                        <div style={{ color: '#555', fontSize: '11px', fontStyle: 'italic' }}>No history yet</div>
                    )}
                </div>
            </div>

            {/* 2. MAIN CONTENT AREA */}
            <div className="main-content" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                
                {/* HEADER / NAVBAR */}
                <header style={{ height: "55px", padding: "0 15px", background: "#2d2d2d", display: "flex", gap: "12px", alignItems: 'center', borderBottom: "1px solid #111" }}>
                    
                    {/* Language Selection */}
                    <div style={{ display: 'flex', alignItems: 'center', color:'red', gap: '8px', background: '#3e3e42', padding: '4px 10px', borderRadius: '4px', border: '1px solid #555' }}>
                        <span style={{ fontSize: '10px', color: '#bbb', fontWeight: 'bold' ,color:'palegreen'}}>LANG</span>
                        <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ background: 'transparent', color: '#61dafb', border: "none", fontWeight: "bold", cursor: 'pointer', outline: 'none' }}>
                            <option value="c" style={{background:"#2d2d2d"}}>C</option>
                            <option value="cpp" style={{background:"#2d2d2d"}}>C++</option>
                            <option value="java" style={{background:"#2d2d2d"}}>Java</option>
                            <option value="python" style={{background:"#2d2d2d"}}>Python</option>
                        </select>
                    </div>

                    <button onClick={handleAiFix} style={{ background: "#8a2be2", color: 'white', padding: '6px 14px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', border:'none', borderRadius:'4px', cursor:'pointer' }}>
                        <Sparkles size={14} /> AI FIX
                    </button>

                    <div className="dropdown">
                        <button className="nav-btn save-btn-colored"><Download size={14} /> Save</button>
                        <div className="dropdown-content">
                            <button onClick={() => handleSaveFile('pdf')}>PDF Report</button>
                            <button onClick={() => handleSaveFile('word')}>Word Doc</button>
                        </div>
                    </div>

                    <button onClick={() => setShowBoard(true)} className="nav-btn" style={{ background: "#3498db" }}>
                        <Monitor size={14} /> Board
                    </button>

                    <button 
                        onClick={() => {
                            navigator.clipboard.writeText(window.location.href);
                            alert("Invite link copied to clipboard! 📋");
                        }} 
                        className="nav-btn" 
                        style={{ background: "#444", border: "1px solid #555", color:'yellow', fontWeight:'bold' }}
                    >
                        <Send size={14} /> Share
                    </button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#3e3e42', padding: '4px 10px', borderRadius: '4px', border: '1px solid #555' }}>
                        <span style={{ fontSize: '10px', color: '#bbb', fontWeight: 'bold' ,color:'palegreen'}}>THEME</span>
                        <button onClick={() => setTheme(theme === 'vs-dark' ? 'light' : 'vs-dark')} style={{ background: 'none',color:'red', border: 'none', color: '#ffcc00', cursor:'pointer', display:'flex' }}>
                            {theme === 'vs-dark' ? <Sun size={16}/> : <Moon size={16}/>}
                        </button>
                    </div>

                    <button onClick={() => setCode('')} style={{ background: "#d9534f", color: 'white', padding: '6px 12px', border:'none', borderRadius:'4px', cursor:'pointer' }}>
                        <Trash2 size={14} />
                    </button>

                    <button onClick={handleRunCode} disabled={isRunning} style={{ background: isRunning ? "#666" : "#4caf50", color: 'white', padding: '6px 20px', fontWeight: 'bold', border:'none', borderRadius:'4px', cursor:'pointer', display:'flex', gap:'5px', marginLeft: 'auto' }}>
                        {isRunning ? "..." : <><Play size={14} fill="white" /> RUN</>}
                    </button>
                </header>

                {/* EDITOR AREA */}
                <div style={{ flex: 1, borderBottom: '1px solid #333' }}>
                    <Editor 
                        height="100%" 
                        theme={theme} 
                        language={language} 
                        value={code} 
                        onMount={handleEditorDidMount} 
                        onChange={(v) => { 
                            setCode(v); 
                            socket.emit('code-change', { roomId, code: v }); 
                        }} 
                    />
                </div>

                {/* TERMINAL / INPUT AREA */}
                <div style={{ height: "180px", display: "flex", background: "#000" }}>
                    <textarea 
                        value={userInput} 
                        onChange={(e) => setUserInput(e.target.value)} 
                        style={{ width: '30%', background: '#0a0a0a', color: '#999', padding: '12px', border: 'none', borderRight: "1px solid #222", resize: 'none', outline: 'none' }} 
                        placeholder="Stdin (Input) here..." 
                    />
                    <pre style={{ flex: 1, color: '#00ff00', padding: '12px', overflowY: 'auto', margin: 0, fontSize: "12px", fontFamily: "monospace", whiteSpace: 'pre-wrap' }}>
                        {output}
                    </pre>
                </div>
            </div>

            {/* 3. RIGHT SIDEBAR */}
            <div className="right-sidebar" style={{ width: "350px", background: "#252526", borderLeft: "1px solid #333", display: 'flex', flexDirection: 'column', color: "white" }}>
                <div style={{ padding: "15px", background: "#2d2d2d", borderBottom: "1px solid #333" }}>
                    <div style={{ fontSize: '11px', color: '#61dafb', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Activity size={14} /> LIVE ACTIVITY MONITOR
                    </div>
                    <div style={{ background: '#1e1e1e', padding: '12px', borderRadius: '6px', border: '1px solid #444', color: '#4caf50', fontFamily: 'monospace', fontSize: '12px' }}>
                        &gt; {activity}
                    </div>
                </div>

                <div style={{ padding: "15px", background: "#2d2d2d" }}>
                    <div style={{ fontSize: '11px', color: '#8a2be2', fontWeight: 'bold', marginBottom: '6px' }}>AI CONSULTANT</div>
                    <form onSubmit={askQuestion} style={{ display: 'flex', gap: '6px' }}>
                        <input name="aiQuery" style={{ flex: 1, background: '#111', color: 'white', border: '1px solid #8a2be2', padding: '10px', borderRadius: '4px' }} placeholder="Ask logic or fix..." />
                        <button type="submit" style={{ background: '#8a2be2', border:'none', padding: '10px', borderRadius: '4px' }}><Send size={16} color="white"/></button>
                    </form>
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: "15px" }}>
                    {messages.map((m, i) => (
                        <div key={i} style={{ marginBottom: '18px' }}>
                            <div style={{ color: m.sender.includes("AI") ? "#8a2be2" : "#61dafb", fontSize: '10px', fontWeight: 'bold' }}>{m.sender.toUpperCase()}</div>
                            <div style={{ background: '#333', padding: '12px', borderRadius: '6px', fontSize: '12px' }}><ReactMarkdown>{m.message}</ReactMarkdown></div>
                        </div>
                    ))}
                    <div ref={chatEndRef} />
                </div>

                <div style={{ padding: "15px", borderTop: "1px solid #333" }}>
                    <form onSubmit={sendMessage} style={{ display: 'flex', gap: '6px' }}>
                        <input value={msgInput} onChange={(e) => setMsgInput(e.target.value)} style={{ flex: 1, background: '#111', color: 'white', padding: '10px', borderRadius: '4px', border:'1px solid #444' }} placeholder="Team message..." />
                        <button type="submit" style={{ background: '#444', border:'none', padding: '10px', borderRadius: '4px' }}><Send size={16} color="white"/></button>
                    </form>
                </div>
            </div>

            {/* WHITEBOARD MODAL */}
            {showBoard && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <div style={{ background: '#fff', padding: '20px', borderRadius: '12px' }}>
                        <div style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}>
                            <button onClick={() => setBrushColor('#000')}><Pencil size={20}/></button>
                            <button onClick={() => setBrushColor('#fff')}><Eraser size={20}/></button>
                            <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} />
                            <button onClick={() => setShowBoard(false)} style={{ marginLeft: 'auto', background: '#d9534f', color: 'white', border:'none', padding:'5px 10px', borderRadius: '4px' }}><X /></button>
                        </div>
                        <canvas ref={canvasRef} width="800" height="500" onMouseDown={() => { setIsDrawing(true); canvasRef.current.getContext('2d').beginPath(); }} onMouseMove={draw} onMouseUp={() => setIsDrawing(false)} style={{ border: '1px solid #ddd', background: 'white' }} />
                    </div>
                </div>
            )}
        </div>
    );
    
  }
export default App;

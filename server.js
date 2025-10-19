import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve static frontend files
app.use(express.static(path.join(path.resolve(), 'public')));

// WebSocket for real-time graffiti
io.on('connection', (socket) => {
  console.log('A user connected');

  // Listen for strokes from a user
  socket.on('drawStroke', (strokeData) => {
    // Broadcast to all other users
    socket.broadcast.emit('drawStroke', strokeData);
  });

  socket.on('disconnect', () => console.log('User disconnected'));
});

// Listen on Render port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

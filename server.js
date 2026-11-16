import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50e6
});

app.use(cors());
app.use(express.static(join(__dirname, 'public')));

const rooms = new Map();
const disconnectTimers = new Map();
const validTokens = new Set();
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'admin123';

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

io.on('connection', (socket) => {
  socket.on('auth', (data) => {
    const { password, token } = data;
    if (token && validTokens.has(token)) {
      socket.authenticated = true;
      socket.emit('authSuccess', { token });
      return;
    }
    if (password === ACCESS_PASSWORD) {
      const newToken = crypto.randomBytes(32).toString('hex');
      validTokens.add(newToken);
      socket.authenticated = true;
      socket.emit('authSuccess', { token: newToken });
    } else {
      socket.emit('authError', { message: 'Неверный код доступа' });
    }
  });

  socket.on('createRoom', (data) => {
    if (!socket.authenticated) return;
    const { nick, color } = data;
    const roomId = generateRoomId();
    rooms.set(roomId, {
      id: roomId,
      creator: socket.id,
      users: new Map([[socket.id, { id: socket.id, nick, color }]]),
      createdAt: Date.now()
    });
    socket.join(roomId);
    socket.emit('roomCreated', { roomId });
  });

  socket.on('joinRoom', (data) => {
    if (!socket.authenticated) return;
    const { roomId, nick, isCreator, color } = data;
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Комната не найдена или уже закрыта' });
      return;
    }

    if (!isCreator) {
      const nickExists = Array.from(room.users.values()).some(u => u.nick.toLowerCase() === nick.toLowerCase());
      if (nickExists) {
        socket.emit('error', { message: 'Этот никнейм уже занят в комнате' });
        return;
      }
    }

    if (isCreator) {
      room.creator = socket.id;
      if (disconnectTimers.has(roomId)) {
        clearTimeout(disconnectTimers.get(roomId));
        disconnectTimers.delete(roomId);
      }
    }

    room.users.set(socket.id, { id: socket.id, nick, color: color || '#00d4ff' });
    socket.join(roomId);
    io.to(roomId).emit('userJoined', { nick, userCount: room.users.size });
  });

  socket.on('sendMessage', (data) => {
    if (!socket.authenticated) return;
    // ДОБАВЛЕНО: replyTo
    const { roomId, encryptedMessage, type = 'text', duration = 0, fileName, fileSize, fileMime, replyTo } = data;
    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    io.to(roomId).emit('message', {
      userId: socket.id,
      nick: user.nick,
      color: user.color,
      isHost: room.creator === socket.id,
      encryptedMessage,
      type,
      duration,
      fileName,
      fileSize,
      fileMime,
      replyTo, // ДОБАВЛЕНО: Пересылаем цитату
      timestamp: Date.now()
    });
  });

  socket.on('typing', (data) => {
    if (!socket.authenticated) return;
    socket.to(data.roomId).emit('userTyping', { nick: data.nick });
  });

  socket.on('stopTyping', (data) => {
    if (!socket.authenticated) return;
    socket.to(data.roomId).emit('userStoppedTyping', { nick: data.nick });
  });

  socket.on('endRoom', (data) => {
    if (!socket.authenticated) return;
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (!room || room.creator !== socket.id) return;
    io.to(roomId).emit('roomEnded');
    rooms.delete(roomId);
    if (disconnectTimers.has(roomId)) {
      clearTimeout(disconnectTimers.get(roomId));
      disconnectTimers.delete(roomId);
    }
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        const user = room.users.get(socket.id);
        room.users.delete(socket.id);
        if (room.creator === socket.id) {
          const timer = setTimeout(() => {
            if (rooms.has(roomId)) {
              io.to(roomId).emit('roomEnded');
              rooms.delete(roomId);
            }
          }, 30000);
          disconnectTimers.set(roomId, timer);
        } else {
          io.to(roomId).emit('userLeft', { nick: user.nick, userCount: room.users.size });
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

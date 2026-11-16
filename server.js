import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto'; // Для генерации токенов

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50e6 // 50 MB
});

app.use(cors());
app.use(express.static(join(__dirname, 'public')));

const rooms = new Map();
const disconnectTimers = new Map();
const validTokens = new Set(); // Хранилище токенов в памяти

// Берем пароль из переменной окружения (или используем 'admin123' для локальных тестов)
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
  console.log('Пользователь подключился:', socket.id);

  // АВТОРИЗАЦИЯ
  socket.on('auth', (data) => {
    const { password, token } = data;

    // 1. Проверка по токену (если пользователь уже заходил)
    if (token && validTokens.has(token)) {
      socket.authenticated = true;
      socket.token = token;
      socket.emit('authSuccess', { token });
      return;
    }

    // 2. Проверка по паролю
    if (password === ACCESS_PASSWORD) {
      const newToken = crypto.randomBytes(32).toString('hex');
      validTokens.add(newToken);
      socket.authenticated = true;
      socket.token = newToken;
      socket.emit('authSuccess', { token: newToken });
      console.log('Успешная авторизация, выдан токен');
    } else {
      socket.emit('authError', { message: 'Неверный код доступа' });
    }
  });

  socket.on('createRoom', (data) => {
    if (!socket.authenticated) return; // Защита
    const { nick } = data;
    const roomId = generateRoomId();
    rooms.set(roomId, {
      id: roomId,
      creator: socket.id,
      users: new Map([[socket.id, { id: socket.id, nick }]]),
      createdAt: Date.now()
    });
    socket.join(roomId);
    socket.emit('roomCreated', { roomId });
  });

  socket.on('joinRoom', (data) => {
    if (!socket.authenticated) return; // Защита
    const { roomId, nick, isCreator } = data;
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Комната не найдена или уже закрыта' });
      return;
    }

    if (isCreator) {
      room.creator = socket.id;
      if (disconnectTimers.has(roomId)) {
        clearTimeout(disconnectTimers.get(roomId));
        disconnectTimers.delete(roomId);
      }
    }

    room.users.set(socket.id, { id: socket.id, nick });
    socket.join(roomId);
    io.to(roomId).emit('userJoined', { nick, userCount: room.users.size });
  });

  socket.on('sendMessage', (data) => {
    if (!socket.authenticated) return;
    const { roomId, encryptedMessage, type = 'text', duration = 0, fileName, fileSize, fileMime } = data;
    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    io.to(roomId).emit('message', {
      userId: socket.id,
      nick: user.nick,
      encryptedMessage,
      type,
      duration,
      fileName,
      fileSize,
      fileMime,
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
    // ... (код дисконнекта и таймеров остается без изменений)
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

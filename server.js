import 'dotenv/config';
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

// Безопасный пароль
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || crypto.randomBytes(4).toString('hex');
if (!process.env.ACCESS_PASSWORD) {
  console.warn(`ВНИМАНИЕ: Переменная ACCESS_PASSWORD не задана! Сгенерирован случайный пароль: ${ACCESS_PASSWORD}`);
}

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
    if (token) {
      if (validTokens.has(token)) {
        socket.authenticated = true;
        socket.emit('authSuccess', { token });
      } else {
        socket.emit('tokenExpired');
      }
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
    const hostToken = crypto.randomBytes(16).toString('hex');

    rooms.set(roomId, {
      id: roomId,
      creator: socket.id,
      hostToken: hostToken,
      users: new Map([[socket.id, { id: socket.id, nick, color }]]),
      messages: new Map(),
      createdAt: Date.now()
    });
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, hostToken });
  });

  socket.on('joinRoom', (data) => {
    if (!socket.authenticated) return;
    const { roomId, nick, hostToken, color } = data;
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Комната не найдена или уже закрыта' });
      return;
    }

    const isRealCreator = hostToken && room.hostToken === hostToken;

    if (!isRealCreator) {
      const nickExists = Array.from(room.users.values()).some(u => u.nick.toLowerCase() === nick.toLowerCase() && u.id !== socket.id);
      if (nickExists) {
        socket.emit('error', { message: 'Этот никнейм уже занят в комнате' });
        return;
      }
    }

    if (isRealCreator) {
      room.creator = socket.id;
      if (disconnectTimers.has(roomId)) {
        clearTimeout(disconnectTimers.get(roomId));
        disconnectTimers.delete(roomId);
      }
    }

    room.users.set(socket.id, { id: socket.id, nick, color: color || '#00d4ff' });
    socket.join(roomId);
    
    // ДОБАВЛЕНО: Подтверждение успешного входа
    socket.emit('roomJoined', { isCreator: isRealCreator, hostToken: isRealCreator ? room.hostToken : null });

    const onlineIds = Array.from(room.users.keys());
    io.to(roomId).emit('onlineUsers', onlineIds);
    io.to(roomId).emit('userJoined', { nick, userCount: room.users.size });
  });

  socket.on('sendMessage', (data) => {
    if (!socket.authenticated) return;
    const { roomId, msgId, encryptedMessage, type = 'text', duration = 0, fileName, fileSize, fileMime, replyTo, expiresIn } = data;
    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    if (!room.messages) room.messages = new Map();
    room.messages.set(msgId, { senderId: socket.id });
    
    if (room.messages.size > 1000) {
      const firstKey = room.messages.keys().next().value;
      room.messages.delete(firstKey);
    }

    io.to(roomId).emit('message', {
      msgId, userId: socket.id, nick: user.nick, color: user.color,
      isHost: room.creator === socket.id, encryptedMessage, type, duration,
      fileName, fileSize, fileMime, replyTo, expiresIn, timestamp: Date.now()
    });
  });

  socket.on('deleteMessage', (data) => {
    if (!socket.authenticated) return;
    const { roomId, msgId } = data;
    const room = rooms.get(roomId);
    if (!room || !room.messages) return;

    const msgInfo = room.messages.get(msgId);
    if (!msgInfo || msgInfo.senderId !== socket.id) return;

    room.messages.delete(msgId);
    io.to(roomId).emit('messageDeleted', { msgId });
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
        
        const onlineIds = Array.from(room.users.keys());
        io.to(roomId).emit('onlineUsers', onlineIds);

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

// ============================================================
// FLASHDROP CALLS: WebRTC-сигнализация (Mesh)
// ============================================================
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_PASSWORD = process.env.TURN_PASSWORD || '';

function buildIceServers() {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  if (TURN_USERNAME && TURN_PASSWORD) {
    iceServers.push({
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp'
      ],
      username: TURN_USERNAME,
      credential: TURN_PASSWORD
    });
  }
  return iceServers;
}

function callPeerList(room) {
  return Array.from(room.callPeers.values()).map(p => ({ peerId: p.peerId, nick: p.nick, color: p.color }));
}

function callCleanup(socket) {
  const roomId = socket.data.callRoom;
  const peerId = socket.data.peerId;
  if (!roomId || !peerId) return;
  const room = rooms.get(roomId);
  if (room && room.callPeers) {
    room.callPeers.delete(peerId);
    socket.leave('call:' + roomId);
    io.to('call:' + roomId).emit('call:peer-left', { peerId });
    io.to(roomId).emit('call:presence', { count: room.callPeers.size, peers: callPeerList(room) });
    if (room.callPeers.size === 0) delete room.callPeers;
    console.log(`[call] peer ${peerId} left call in ${roomId}`);
  }
  socket.data.peerId = null;
  socket.data.callRoom = null;
}

io.on('connection', (socket) => {
  socket.on('call:get-ice', ({ roomId } = {}) => {
    if (!socket.authenticated) return;
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) return;
    socket.emit('call:ice-config', { iceServers: buildIceServers() });
  });

  socket.on('call:join', ({ roomId, peerId }) => {
    if (!socket.authenticated) return;
    const room = rooms.get(roomId);
    if (!room || !peerId) return;
    const me = room.users.get(socket.id);
    if (!me) return;
    if (!room.callPeers) room.callPeers = new Map();
    if (room.callPeers.has(peerId)) return;

    room.callPeers.set(peerId, { peerId, socketId: socket.id, nick: me.nick, color: me.color });
    socket.data.peerId = peerId;
    socket.data.callRoom = roomId;
    socket.join('call:' + roomId);

    socket.emit('call:joined', { peers: callPeerList(room).filter(p => p.peerId !== peerId) });
    socket.to('call:' + roomId).emit('call:peer-joined', { peerId, nick: me.nick, color: me.color });
    io.to(roomId).emit('call:presence', { count: room.callPeers.size, peers: callPeerList(room) });
    console.log(`[call] ${me.nick} joined call in ${roomId} (${room.callPeers.size} in call)`);
  });

  socket.on('call:signal', ({ roomId, to, payload }) => {
    if (!socket.authenticated) return;
    if (socket.data.callRoom !== roomId) return;
    
    const room = rooms.get(roomId);
    if (!room || !room.callPeers || !socket.data.peerId) return;
    const target = room.callPeers.get(to);
    if (!target) return;
    io.to(target.socketId).emit('call:signal', { from: socket.data.peerId, payload });
  });

  socket.on('call:leave', () => callCleanup(socket));
  socket.on('disconnect', () => callCleanup(socket));
});

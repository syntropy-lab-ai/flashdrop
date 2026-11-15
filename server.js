import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
const disconnectTimers = new Map(); // Таймеры для отключившихся создателей

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  socket.on('createRoom', (data) => {
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
    console.log(`Комната создана: ${roomId}, создатель: ${nick}`);
  });

  socket.on('joinRoom', (data) => {
    const { roomId, nick, isCreator } = data;
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Комната не найдена или уже закрыта' });
      return;
    }

    // Если возвращается создатель, отменяем таймер удаления
    if (isCreator) {
      room.creator = socket.id; // Обновляем ID создателя на новый
      if (disconnectTimers.has(roomId)) {
        clearTimeout(disconnectTimers.get(roomId));
        disconnectTimers.delete(roomId);
        console.log(`Создатель вернулся в комнату ${roomId}`);
      }
    }

    room.users.set(socket.id, { id: socket.id, nick });
    socket.join(roomId);
    io.to(roomId).emit('userJoined', { nick, userCount: room.users.size });
    console.log(`${nick} присоединился к комнате ${roomId}`);
  });

  socket.on('sendMessage', (data) => {
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
    const { roomId, nick } = data;
    socket.to(roomId).emit('userTyping', { nick });
  });

  socket.on('stopTyping', (data) => {
    const { roomId, nick } = data;
    socket.to(roomId).emit('userStoppedTyping', { nick });
  });

  socket.on('endRoom', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (!room || room.creator !== socket.id) return;

    io.to(roomId).emit('roomEnded');
    rooms.delete(roomId);
    if (disconnectTimers.has(roomId)) {
      clearTimeout(disconnectTimers.get(roomId));
      disconnectTimers.delete(roomId);
    }
    console.log(`Комната ${roomId} закрыта вручную`);
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        const user = room.users.get(socket.id);
        room.users.delete(socket.id);
        
        if (room.creator === socket.id) {
          // Создатель отключился — даем 30 секунд на возвращение
          console.log(`Создатель отключился от ${roomId}. Ждем 30 секунд...`);
          const timer = setTimeout(() => {
            if (rooms.has(roomId)) {
              io.to(roomId).emit('roomEnded');
              rooms.delete(roomId);
              console.log(`Комната ${roomId} удалена (создатель не вернулся)`);
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

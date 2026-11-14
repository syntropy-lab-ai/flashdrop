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
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.static(join(__dirname, 'public')));

// Хранилище комнат ТОЛЬКО в оперативной памяти (без БД)
const rooms = new Map();

// Генерация случайного ID комнаты
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

  // Создание комнаты
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

  // Присоединение к комнате
  socket.on('joinRoom', (data) => {
    const { roomId, nick } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('error', { message: 'Комната не найдена или уже закрыта' });
      return;
    }

    room.users.set(socket.id, { id: socket.id, nick });
    socket.join(roomId);

    // Уведомляем всех в комнате
    io.to(roomId).emit('userJoined', {
      nick,
      userCount: room.users.size
    });

    console.log(`${nick} присоединился к комнате ${roomId}`);
  });

  // Отправка сообщения
  socket.on('sendMessage', (data) => {
    const { roomId, encryptedMessage } = data;
    const room = rooms.get(roomId);

    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    // Отправляем зашифрованное сообщение всем в комнате (включая отправителя)
    io.to(roomId).emit('message', {
      userId: socket.id,
      nick: user.nick,
      encryptedMessage,
      timestamp: Date.now()
    });
  });

  // Индикатор набора текста
  socket.on('typing', (data) => {
    const { roomId, nick } = data;
    socket.to(roomId).emit('userTyping', { nick });
  });

  socket.on('stopTyping', (data) => {
    const { roomId, nick } = data;
    socket.to(roomId).emit('userStoppedTyping', { nick });
  });

  // Завершение комнаты (только создатель)
  socket.on('endRoom', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);

    if (!room) return;
    if (room.creator !== socket.id) return;

    // Уведомляем всех
    io.to(roomId).emit('roomEnded');

    // Удаляем комнату из памяти
    rooms.delete(roomId);
    console.log(`Комната ${roomId} закрыта и удалена`);
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);

    // Ищем комнату пользователя
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        const user = room.users.get(socket.id);
        room.users.delete(socket.id);

        // Если это создатель — закрываем комнату
        if (room.creator === socket.id) {
          io.to(roomId).emit('roomEnded');
          rooms.delete(roomId);
          console.log(`Комната ${roomId} закрыта (создатель вышел)`);
        } else {
          // Уведомляем остальных
          io.to(roomId).emit('userLeft', {
            nick: user.nick,
            userCount: room.users.size
          });
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

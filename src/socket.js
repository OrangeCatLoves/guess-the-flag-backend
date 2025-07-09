const { Server } = require('socket.io');

let io;

const onlineUsers = new Map(); // socket.id => { userId, username }

function initSocket(server) {
  io = new Server(server, {
    cors: { 
        origin: "http://localhost:5173",
        methods: ["GET", "POST"],
    }
  });

  io.on('connection', (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    socket.on('register', ({ userId, username }) => {
      onlineUsers.set(socket.id, { userId, username });
      broadcastOnlineUsers();
    });

    socket.on('invite', ({ toUserId, from }) => {
      const recipientSocket = [...onlineUsers.entries()]
        .find(([_, u]) => u.userId === toUserId)?.[0];
      if (recipientSocket) {
        io.to(recipientSocket).emit('invite-received', from);
      }
    });

    socket.on('accept-invite', ({ toUserId, fromUserId }) => {
      const userASocket = [...onlineUsers.entries()]
        .find(([_, u]) => u.userId === toUserId)?.[0];
      const userBSocket = [...onlineUsers.entries()]
        .find(([_, u]) => u.userId === fromUserId)?.[0];
      if (userASocket && userBSocket) {
        io.to(userASocket).emit('start-duel', { opponentId: fromUserId });
        io.to(userBSocket).emit('start-duel', { opponentId: toUserId });
      }
    });

    socket.on('disconnect', () => {
      console.log(`❌ User disconnected: ${socket.id}`);
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers();
    });
  });
}

function broadcastOnlineUsers() {
  const users = [...onlineUsers.values()];
  io.emit('online-users', users);
}

module.exports = { initSocket };

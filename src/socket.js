const { Server } = require('socket.io');
const db = require('./db'); // Adjust the path as necessary

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

    socket.on('register', async ({ userId, username, guest }) => {
      let wins = 0;
      if (!guest) {
        // only query DB for real users
        const { rows } = await db.query(
          'SELECT duelvictories FROM users WHERE id = $1',
          [userId]
        );
        wins = rows[0]?.duelvictories ?? 0;
      }
      // store socketId so clients can filter themselves out
      onlineUsers.set(socket.id, {
        socketId:       socket.id,
        userId,
        username,
        guest,
        duelvictories:  wins
      });
      broadcastOnlineUsers();
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
  console.log('🔔 broadcasting', users.length, 'online users:', users)
  io.emit('online-users', users);
}

module.exports = { initSocket };

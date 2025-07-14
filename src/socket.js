const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const db = require('./db'); // Adjust the path as necessary
const { getRandomFlag } = require('./game'); // Adjust the path as necessary

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
    const ip = socket.handshake.address;

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

     // Handle invite requests
    socket.on('invite', ({ toSocketId }) => {
      const sender = onlineUsers.get(socket.id);
      if (!sender) return;
      // Emit to the target socket an invitation event
      io.to(toSocketId).emit('invite-received', {
        socketId:       socket.id,
        username:       sender.username,
        guest:          sender.guest,
        duelvictories:  sender.duelvictories
      });
    });

    socket.on('accept-invite', async ({ inviterSocketId }) => {
      // 1) Create a new session with a random flag
      const sessionId = uuidv4();
      const flag      = getRandomFlag();
      await db.query(
        'INSERT INTO sessions (id, flag_code, started_at) VALUES ($1, $2, NOW())',
        [sessionId, flag.code]
      );

      // 2) Join both sockets into the session room
      socket.join(sessionId); 
      const inviterSocket = io.sockets.sockets.get(inviterSocketId);
      if (inviterSocket) inviterSocket.join(sessionId);

      // 3) Notify both that the duel is starting, passing the sessionId
      io.to(sessionId).emit('start-duel', { sessionId });
    })

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

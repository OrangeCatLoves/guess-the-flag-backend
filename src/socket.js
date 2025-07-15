const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const db = require('./db'); // Adjust the path as necessary
const { flags, getRandomFlag } = require('./game'); // Adjust the path as necessary

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
      // generate session id
      const sessionId = uuidv4()
      // 2) Pick 5 *distinct* random flags
      //    a) grab all codes
      const allCodes = flags.map(f => f.code);
      //    b) shuffle them
      for (let i = allCodes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allCodes[i], allCodes[j]] = [allCodes[j], allCodes[i]];
      }
      //    c) take the first five
      const codes = allCodes.slice(0, 5);

      // insert them as JSONB array
      await db.query(
        `INSERT INTO sessions (id, flag_code, flag_codes, started_at)
        VALUES ($1, $2, $3, NOW())`,
        // flag_code stays the first one for backwards-compat
        [sessionId, codes[0], JSON.stringify(codes)]
      );

      // join room & notify both
      socket.join(sessionId);
      const inviter = io.sockets.sockets.get(inviterSocketId);
      if (inviter) inviter.join(sessionId);
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

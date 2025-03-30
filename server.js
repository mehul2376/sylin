const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Configure CORS
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  },
});
const upload = multer({ storage });

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// In-memory data store
const users = new Map(); // userId -> socket
const activeConnections = new Map(); // userId -> socket
const anonymousConnections = new Map(); // anonymousId -> socket
const groupRooms = new Map(); // groupId -> [userIds]
const userGroups = new Map(); // userId -> [groupIds]
const userStatus = new Map(); // userId -> status
const friendRequests = []; // {sender_id, receiver_id, status}

// Handle file uploads
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

// Verify user (simplified - would use proper JWT in production)
const verifyUser = (token) => {
  // In a real app, you'd verify JWT here
  // For simplicity, we're just returning the token as the user ID
  return token;
};

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('New connection');
  
  // Get user info from auth token
  const token = socket.handshake.auth.token;
  let userId;
  
  try {
    userId = verifyUser(token);
    
    if (userId) {
      // Store user connection
      activeConnections.set(userId, socket);
      userStatus.set(userId, 'online');
      console.log(`User ${userId} connected`);
      
      // Notify group members about user's online status
      if (userGroups.has(userId)) {
        userGroups.get(userId).forEach(groupId => {
          socket.to(groupId).emit('member-status', {
            userId,
            status: 'online'
          });
        });
      }
    }
  } catch (error) {
    console.error('Authentication error:', error);
    socket.disconnect();
    return;
  }
  
  // Handle creating a group
  socket.on('create_group', (data) => {
    const { name, members } = data;
    if (!name) return;
    
    console.log(`Creating group: ${name} with members:`, members);
    
    // Generate a unique group ID
    const groupId = uuidv4();
    
    // Store group members
    groupRooms.set(groupId, members || [userId]);
    
    // Add user to group
    if (!userGroups.has(userId)) {
      userGroups.set(userId, []);
    }
    userGroups.get(userId).push(groupId);
    
    // Join socket room for this group
    socket.join(groupId);
    
    // Send confirmation
    socket.emit('group_created', {
      group_id: groupId,
      name
    });
    
    console.log(`Group created: ${groupId} (${name})`);
  });
  
  // Handle joining a group
  socket.on('join_room', (data) => {
    const { room_id } = data;
    if (!room_id) return;
    
    socket.join(room_id);
    console.log(`User ${userId} joined room ${room_id}`);
    
    // If it's a group, add user to members list
    if (groupRooms.has(room_id)) {
      const members = groupRooms.get(room_id);
      if (!members.includes(userId)) {
        members.push(userId);
        groupRooms.set(room_id, members);
      }
      
      if (!userGroups.has(userId)) {
        userGroups.set(userId, []);
      }
      const userGroupsList = userGroups.get(userId);
      if (!userGroupsList.includes(room_id)) {
        userGroupsList.push(room_id);
      }
    }
  });
  
  // Handle group messages
  socket.on('group_message', (data) => {
    const { group_id, content, type, fileUrl } = data;
    
    if (!group_id || (!content && !fileUrl)) return;
    
    console.log(`Group message to ${group_id}: ${content}`);
    
    const message = {
      id: uuidv4(),
      group_id,
      sender: userId,
      content,
      type: type || 'text',
      fileUrl,
      timestamp: new Date().toISOString()
    };
    
    // Broadcast to all members in the group
    io.to(group_id).emit('receive-message', message);
  });
  
  // Handle direct messages
  socket.on('send-message', (data) => {
    const { contactId, message, is_anonymous } = data;
    
    if (!contactId || (!message.content && !message.fileUrl)) return;
    
    console.log(`Direct message to ${contactId}: ${message.content}`);
    
    // Send message to recipient
    const recipientSocket = activeConnections.get(contactId);
    if (recipientSocket) {
      recipientSocket.emit('receive-message', message);
    }
  });
  
  // Handle friend requests
  socket.on('friend_request', (data) => {
    const { receiver_id, timestamp } = data;
    
    if (!receiver_id) return;
    
    console.log(`Friend request from ${userId} to ${receiver_id}`);
    
    // Check if request already exists
    const existingRequest = friendRequests.find(
      req => req.sender_id === userId && 
             req.receiver_id === receiver_id && 
             req.status === 'pending'
    );
    
    if (existingRequest) {
      socket.emit('friend_request_sent', {
        receiver: receiver_id,
        status: 'already_sent',
        timestamp
      });
      return;
    }
    
    // Create new friend request
    friendRequests.push({
      sender_id: userId,
      receiver_id,
      status: 'pending'
    });
    
    // Send notification to receiver
    const receiverSocket = activeConnections.get(receiver_id);
    if (receiverSocket) {
      receiverSocket.emit('friend_request', {
        sender: userId,
        timestamp
      });
    }
    
    // Send confirmation to sender
    socket.emit('friend_request_sent', {
      receiver: receiver_id,
      status: 'sent',
      timestamp
    });
  });
  
  // Handle friend request responses
  socket.on('friend_request_response', (data) => {
    const { sender_id, accepted, timestamp } = data;
    
    if (!sender_id) return;
    
    console.log(`Friend request response: ${userId} ${accepted ? 'accepted' : 'rejected'} request from ${sender_id}`);
    
    // Find the request
    const requestIndex = friendRequests.findIndex(
      req => req.sender_id === sender_id && 
             req.receiver_id === userId && 
             req.status === 'pending'
    );
    
    if (requestIndex === -1) {
      socket.emit('friend_request_response_sent', {
        sender: sender_id,
        status: 'not_found',
        timestamp
      });
      return;
    }
    
    // Update request status
    friendRequests[requestIndex].status = accepted ? 'accepted' : 'rejected';
    
    // Notify sender
    const senderSocket = activeConnections.get(sender_id);
    if (senderSocket) {
      senderSocket.emit('friend_request_response', {
        receiver: userId,
        accepted,
        timestamp
      });
    }
    
    // Confirm to receiver
    socket.emit('friend_request_response_sent', {
      sender: sender_id,
      accepted,
      timestamp
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    if (userId) {
      console.log(`User ${userId} disconnected`);
      
      // Update user status
      activeConnections.delete(userId);
      userStatus.set(userId, 'offline');
      
      // Notify group members about user's offline status
      if (userGroups.has(userId)) {
        userGroups.get(userId).forEach(groupId => {
          socket.to(groupId).emit('member-status', {
            userId,
            status: 'offline'
          });
        });
      }
    }
  });
});

// Start server
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const newPort = PORT + 1;
    console.log(`Port ${PORT} is in use, trying ${newPort} instead.`);
    
    // Update .env.local with new port
    try {
      let envContent = fs.readFileSync('.env.local', 'utf8');
      envContent = envContent.replace(
        /NEXT_PUBLIC_SOCKET_URL=http:\/\/localhost:\d+/,
        `NEXT_PUBLIC_SOCKET_URL=http://localhost:${newPort}`
      );
      fs.writeFileSync('.env.local', envContent);
      
      // Try the new port
      server.listen(newPort, () => {
        console.log(`Server running on port ${newPort}`);
        console.log(`Updated .env.local with new port ${newPort}`);
      });
    } catch (error) {
      console.error('Failed to update .env.local file:', error);
      // Try the new port anyway
      server.listen(newPort, () => {
        console.log(`Server running on port ${newPort}`);
        console.log(`Warning: Failed to update .env.local file`);
      });
    }
  } else {
    console.error('Server error:', err);
  }
}); 
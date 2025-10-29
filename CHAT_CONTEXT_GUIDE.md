# Chat Context Enhancement - VivasayiAI

## Overview
The chat system has been enhanced to provide contextual awareness, allowing the AI to remember and reference previous conversations within a chat session.

## Key Features

### 1. **Chat History Context**
- The AI now maintains awareness of the conversation history
- Previous messages are included in the AI prompt for contextual responses
- Last 6 messages (3 user-AI pairs) are used to keep context manageable

### 2. **Enhanced RAG + Context**
- Combines vector search (RAG) with chat history
- Provides both agricultural knowledge base context AND conversation context
- Fallback to chat context even if RAG fails

### 3. **Session Management**
- Create new chat sessions or continue existing ones
- Retrieve chat session history
- List all user's chat sessions

## API Endpoints

### 1. Send Message with Context
```
POST /api/chat/
```

**Request Body:**
```json
{
  "message": "How should I water my tomatoes?",
  "chatId": "optional_existing_chat_id",
  "userEmail": "farmer@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Chat response generated successfully",
  "data": {
    "chatId": "670f8a5b1234567890abcdef",
    "response": "Based on our earlier discussion about your tomato plants...",
    "hasContext": true,
    "hasChatHistory": true,
    "sourceCount": 3,
    "chatHistoryCount": 4,
    "messages": [...],
    "timestamp": "2024-10-29T10:30:00.000Z"
  }
}
```

### 2. Get Chat Session
```
GET /api/chat/session/:chatId?userEmail=farmer@example.com
```

### 3. Get User's Chat Sessions
```
GET /api/chat/sessions?userEmail=farmer@example.com
```

## How Context Works

### Example Conversation Flow:

**Message 1:**
- User: "I'm growing tomatoes in Coimbatore"
- AI: "Great! Coimbatore's climate is excellent for tomatoes..."

**Message 2:**
- User: "What fertilizer should I use?"
- AI: "For your tomatoes in Coimbatore that we discussed earlier, I recommend..."

**Message 3:**
- User: "How often should I water them?"
- AI: "Following up on your tomato cultivation, the watering schedule depends on..."

## Implementation Details

### Chat Context Processing
```javascript
// Build chat context from previous messages
let chatContext = "";
if (chatHistory && chatHistory.length > 0) {
  const recentMessages = chatHistory.slice(-6); // Last 6 messages
  chatContext = recentMessages
    .map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`)
    .join('\n');
}
```

### Enhanced Prompt Structure
```
System Prompt
+
Previous conversation context: [if available]
+
Agricultural knowledge base: [if available]
+
Current user message
```

## Benefits

1. **Continuity**: Users don't need to repeat context in follow-up questions
2. **Personalization**: AI remembers user-specific details (location, crops, problems)
3. **Better Assistance**: More relevant and contextual responses
4. **Natural Flow**: Conversations feel more natural and connected

## Technical Notes

- Chat history is limited to last 6 messages to prevent token overflow
- System gracefully handles both new sessions and existing sessions
- RAG + Context combination provides comprehensive assistance
- MongoDB stores complete conversation history
- Context is session-specific and user-specific

## Usage Example

```javascript
// First message in new session
const response1 = await fetch('/api/chat/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: "I have 2 acres of tomato farm in Salem district",
    userEmail: "farmer@example.com"
  })
});

// Follow-up message with context
const response2 = await fetch('/api/chat/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: "What's the best irrigation method for my farm?",
    chatId: response1.data.chatId, // Continue same session
    userEmail: "farmer@example.com"
  })
});
```

The AI will now reference the Salem district and tomato farm context from the first message when responding to the irrigation question.
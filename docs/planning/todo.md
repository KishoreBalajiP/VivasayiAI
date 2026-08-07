# 🌾 Tamil Nadu Farming Assistant – TODO (Web + WhatsApp AI-Powered Farming Helper)

> **Metadata**
> - **Title:** Original Capstone TODO (historical)
> - **Version:** 1.0
> - **Status:** `[SUPERSEDED]`
> - **Owner:** PM (historical)
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [05_Product_Roadmap](../product/05_Product_Roadmap.md) · [17_Backlog](17_Backlog.md)

> **Status notice:** This is the original capstone plan. It is **superseded** by [05_Product_Roadmap.md](../product/05_Product_Roadmap.md) and [17_Backlog.md](17_Backlog.md). Several unchecked items here contradict current decisions (e.g., Firebase auth → AWS Cognito; OpenWeatherMap → Open-Meteo; Twilio → WhatsApp Business API; `react-router-dom` → single-page conditional render). Keep this document as historical reference only; do not use it for planning.

An AI-based, bilingual (Tamil + English) farming assistant for Tamil Nadu farmers.  
Supports **voice, text, and image input**, with **Google login** for web and **WhatsApp bot** access.  
Built with **Node.js**, **React**, **MongoDB**, and **Gemini AI**.

---

## 🔹 Phase 1: Project Setup
- [x] Initialize Git repository and folder structure (`backend/`, `frontend/`, `whatsapp/`).
- [x] Create controllers folder and implement MVC pattern
- [x] Refactor routes to use controllers with proper error handling
- [x] Update utils to use ES6 modules consistently
- [ ] Create `.env` file for all API keys (Gemini, Google Cloud, OpenWeatherMap, WhatsApp API/Twilio).
- [ ] Set up Node.js (Express) in `backend/`.
- [ ] Set up React frontend (Vite or CRA) in `frontend/`.
- [ ] Install dependencies:
  - Backend: `express`, `axios`, `cors`, `dotenv`, `mongoose`, `multer`
  - Frontend: `react`, `react-router-dom`, `i18next`, `axios`, `firebase`
  - WhatsApp bot: `twilio`, `express`, `axios`, `dotenv`

---

## 🔹 Phase 2: Authentication (Google Login)
- [ ] Enable Google OAuth in Firebase Console.
- [ ] Add Firebase Auth SDK to React frontend.
- [ ] Implement **Google Sign-In** button → fetch user profile.
- [ ] Create `/auth/google` route in backend to verify sessions.
- [ ] Save basic user data in MongoDB (`name`, `email`, `language`).

---

## 🔹 Phase 3: Database Design
- [ ] Set up MongoDB cluster (Atlas or local).
- [ ] Collections:
  - `users` – info, language, preferences.
  - `queries` – chat logs (timestamp, query, AI response, location, attachments).
  - `context` – soil and crop data per district.
- [ ] Create Mongoose models and test CRUD operations.

---

## 🔹 Phase 4: Core AI Integration (Gemini)
- [x] Connect backend to **Gemini API** (text + vision).
- [x] Create `/api/chat` POST route with RAG integration:
  - Receives user query (text, language, location).
  - Implements vector search with ChromaDB for agricultural knowledge.
  - Builds AI prompt with contextual data.
  - Sends to Gemini → returns AI reply.
- [x] **ENHANCED: Chat Context System** 
  - AI now remembers conversation history within chat sessions
  - Combines RAG (knowledge base) + chat context for better responses
  - Last 6 messages used for context to maintain conversation flow
  - References previous discussions for continuity
- [x] MongoDB chat session storage with message history
- [x] Add `/api/chat/session/:chatId` and `/api/chat/sessions` routes
- [ ] Add `/api/image-query` route for photo-based diagnosis.
- [ ] Ensure AI prompt handles **any farming problem**, not just pests.

---

## 🔹 Phase 5: Weather & Soil Context APIs
- [ ] Integrate **OpenWeatherMap API** (or IMD API) by lat/long or district.
- [ ] Create local JSON for **Tamil Nadu soil types per district**.
- [ ] Auto-attach context to each AI prompt.
- [ ] Add caching for last weather/soil queries.

---

## 🔹 Phase 6: Voice Input & Output (Bilingual)
- [ ] Integrate **Google Speech-to-Text** (`ta-IN` for Tamil, `en-IN` for English).
- [ ] Integrate **Google Text-to-Speech** (Tamil + English voices).
- [ ] Create `/api/speech-to-text` and `/api/text-to-speech` routes.
- [ ] Add frontend microphone capture + audio playback.
- [ ] Auto-detect user language and respond in same language.

---

## 🔹 Phase 7: Frontend Chat Interface (Web)
- [ ] Build main chat UI (React):
  - Message bubbles (User / AI)
  - Microphone, camera, text input
  - Language toggle (Tamil/English)
- [ ] Connect frontend to `/api/query`.
- [ ] Display both text and voice output.
- [ ] Add loading spinner and error handling.

---

## 🔹 Phase 8: WhatsApp Bot Integration
- [ ] Set up Twilio or Meta WhatsApp Business API.
- [ ] Create `/whatsapp/webhook` route in Node.js backend.
- [ ] Handle incoming WhatsApp messages:
  - Text → send to AI backend
  - Audio → convert to text (STT) → send to AI
  - Image → send to Gemini Vision → AI diagnosis
- [ ] Send AI responses back as:
  - Text messages
  - Audio (optional voice messages)
- [ ] Maintain session context for each WhatsApp user.

---

## 🔹 Phase 9: Image Diagnosis Module
- [ ] Implement image upload component in web frontend.
- [ ] Send images → backend → Gemini Vision API.
- [ ] Parse results → pass to LLM for advice.
- [ ] Display text + voice output in Tamil/English.

---

## 🔹 Phase 10: Testing & Deployment
- [ ] Test both web and WhatsApp flows:
  - Text, voice, images
  - Tamil, English, mixed language
  - AI advice accuracy and context handling
- [ ] Deploy backend (Firebase, Render, or Google Cloud Functions).
- [ ] Deploy frontend (Vercel, Firebase Hosting).
- [ ] Monitor logs, API usage, and performance.
- [ ] Plan v2 features: government schemes, price info, offline caching, community Q&A.

---

### ✅ Outcome
Farmers in Tamil Nadu can now:
- Ask **any farming question** via **web app** or **WhatsApp**.  
- Speak or type in **Tamil or English**.  
- Upload images for AI-based crop diagnosis.  
- Receive **location-aware, weather-informed advice** instantly.

**Tech Stack:** Node.js, React, MongoDB, Gemini AI, Google Cloud Speech/TTS, OpenWeatherMap, Twilio WhatsApp API 
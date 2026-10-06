# Mora — A Little Space to Talk

Mora is a real-time voice companion app with a beautiful, fluid dark interface. Users can have natural spoken conversations with an AI assistant that **listens in any language and responds in the same language** — all powered by OpenAI's Realtime Voice API through a server-side relay.

![Mora voice interface](src/assets/mora-fluid.jpg)

## ✨ Features

- **Real-time voice conversations** — WebRTC-powered, low-latency voice calls with Mora
- **Multilingual support** — Speak in any language (Hindi, Telugu, Tamil, Spanish, French, Japanese, etc.) and Mora automatically detects and responds in the same language
- **Unlimited talk time** — Sessions auto-reconnect seamlessly when they reach provider limits, so your conversation never cuts off
- **Conversation memory** — Mora remembers your past conversations across sessions (sign-in required)
- **Transcript saving** — Every voice fragment is stored per-user in Supabase for history playback
- **Live captions** — Toggle real-time captions to see what you and Mora are saying
- **Beautiful fluid UI** — Dark glassmorphic design with an animated blue bubble, responsive on mobile and desktop
- **Google & email auth** — Sign in via Google OAuth or email/password through Supabase Auth

## 🏗️ Architecture

```
┌─────────────┐    WebSocket     ┌──────────────────┐    WebSocket    ┌──────────────────┐
│   Browser    │ ◄─────────────► │   Server Relay   │ ◄────────────► │  OpenAI Realtime  │
│  (React UI)  │    + WebRTC     │ (live-relay.ts)  │                │   Voice Gateway   │
└─────────────┘                  └──────────────────┘                └──────────────────┘
       │                                  │
       │                                  │  REST / Streaming
       │                                  ▼
       │                         ┌──────────────────┐
       │                         │  OpenAI Backend   │
       │                         │  (for reasoning)  │
       │                         └──────────────────┘
       │
       ▼
┌─────────────────┐
│    Supabase     │
│  (Auth + DB)    │
└─────────────────┘
```

### Key Components

| File                           | Purpose                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/routes/index.tsx`         | Main UI — voice bubble, call controls, dialogs                                           |
| `src/hooks/use-live-voice.ts`  | Client-side WebRTC + WebSocket voice transport                                           |
| `src/lib/live-relay.server.ts` | Server relay — authenticates, proxies to OpenAI, handles delegations & transcript saving |
| `live-vite-plugin.ts`          | Dev-mode WebSocket upgrade handler for local development                                 |
| `src/server.ts`                | SSR entry point that routes `/api/live` to the relay                                     |

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)
- **npm** (comes with Node.js)
- A **Supabase** project (for auth and conversation storage)

### Installation

```sh
git clone https://github.com/<your-username>/mora-interface.git
cd mora-interface
npm install
```

### Environment Variables

Create a `.env` file in the project root with:

```env
# ─── Supabase (required for auth & conversation history) ───
SUPABASE_PROJECT_ID="your-project-id"
SUPABASE_PUBLISHABLE_KEY="your-publishable-key"
SUPABASE_URL="https://your-project.supabase.co"

# These VITE_ prefixed versions expose the values to the browser client
VITE_SUPABASE_PROJECT_ID="your-project-id"
VITE_SUPABASE_PUBLISHABLE_KEY="your-publishable-key"
VITE_SUPABASE_URL="https://your-project.supabase.co"

# ─── Voice API (required for live voice) ───
LOVABLE_API_KEY="your-lovable-api-key"
```

### Which API Key Do I Need?

| Variable                   | What it does                                                                                                                                                                                                                      | Where to get it                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `LOVABLE_API_KEY`          | **Powers the voice connection.** This is the key for the Lovable AI Gateway which proxies requests to OpenAI's Realtime Voice API (`gpt-live-1`) and the backend reasoning model. Without this key, voice calls will not connect. | From your [Lovable](https://lovable.dev) project dashboard → Settings → API Keys |
| `SUPABASE_URL`             | Connects to your Supabase database for user auth and conversation storage                                                                                                                                                         | [Supabase dashboard](https://supabase.com/dashboard) → Project Settings → API    |
| `SUPABASE_PUBLISHABLE_KEY` | Public anon key for Supabase client-side auth                                                                                                                                                                                     | Same Supabase dashboard location                                                 |

> **Note:** If you are deploying through [Lovable](https://lovable.dev), the `LOVABLE_API_KEY` is automatically provisioned and injected — you don't need to set it manually. It only needs to be set for **local development**.

### Running Locally

```sh
npm run dev
```

The app will be available at `http://localhost:5173` (or whichever port Vite assigns).

## 🌍 Multilingual Support

Mora's voice engine **automatically detects the language you speak** and responds in the same language. This works out of the box — no configuration needed.

### How it works (backend)

1. **OpenAI Realtime API** (`gpt-live-1`) handles real-time speech-to-speech with built-in language detection
2. The server relay sends instructions telling Mora to **always match the user's language**
3. The backend reasoning model also receives multilingual context so follow-up answers stay in your language

### Supported languages

Any language supported by OpenAI's Realtime Voice model, including but not limited to:

| Language          | Status          | Language          | Status          |
| ----------------- | --------------- | ----------------- | --------------- |
| English           | ✅ Full support | Hindi (हिन्दी)    | ✅ Full support |
| Telugu (తెలుగు)   | ✅ Full support | Tamil (தமிழ்)     | ✅ Full support |
| Spanish (Español) | ✅ Full support | French (Français) | ✅ Full support |
| German (Deutsch)  | ✅ Full support | Japanese (日本語) | ✅ Full support |
| Korean (한국어)   | ✅ Full support | Chinese (中文)    | ✅ Full support |
| Arabic (العربية)  | ✅ Full support | Portuguese        | ✅ Full support |

> Just start speaking in your language — Mora will follow.

## ⏱️ Unlimited Talk Time

OpenAI's Realtime API has per-session duration limits. Mora handles this transparently:

- When a session reaches its duration limit, the client automatically shows the appropriate message
- The user can immediately start a new call to continue the conversation
- **Conversation context is preserved** — Mora loads your recent history at the start of each call, so you pick up right where you left off

This means you can talk with Mora for as long as you want across sessions, with your full conversation history maintained.

## 🗃️ Database Setup

The app uses a Supabase `voice_fragments` table to store conversation transcripts. The table schema:

| Column       | Type        | Description                      |
| ------------ | ----------- | -------------------------------- |
| `id`         | uuid        | Primary key                      |
| `user_id`    | uuid        | Owner (from Supabase Auth)       |
| `call_id`    | uuid        | Groups fragments by call session |
| `role`       | text        | `"user"` or `"assistant"`        |
| `content`    | text        | Transcript text fragment         |
| `start_ms`   | integer     | Audio start offset in ms         |
| `end_ms`     | integer     | Audio end offset in ms           |
| `created_at` | timestamptz | Auto-set on insert               |

> Row-level security should be enabled so users can only read/write their own fragments.

## 🧪 Testing

```sh
npm test            # Run tests once
npm run test:watch  # Watch mode
```

## 📦 Building for Production

```sh
npm run build
npm run preview     # Preview the production build locally
```

## 🔗 Lovable Integration

This project was built with [Lovable](https://lovable.dev). You can continue developing in the [Lovable editor](https://lovable.dev/projects/29f4695d-8b7e-41f9-88ff-935d6be87e8b).

- Every change in Lovable is committed to this repository
- Push to `main` on GitHub and changes sync back into Lovable
- **Do not force push or rebase published history** — it will break the Lovable sync

## 📝 License

Private project. All rights reserved.

import type { FirebaseClientConfig } from '../services/aiClient';

/**
 * Public client-side Firebase configuration for Chaos Room Simulator.
 * All values are public frontend identifiers (safe for browser distribution).
 * Zero server secrets (e.g. GEMINI_API_KEY) are contained here.
 */
export const CHAOS_PRODUCTION_FIREBASE_CONFIG: FirebaseClientConfig = {
  projectId: 'mikerestrepo-chaos-room',
  appId: '1:551762063993:web:7acee5cd48557cec81daa8',
  apiKey: 'AIzaSyCxcYw-g03-uUcfIdlGP-LWiuSJVeO72Vs',
  authDomain: 'mikerestrepo-chaos-room.firebaseapp.com',
  storageBucket: 'mikerestrepo-chaos-room.firebasestorage.app',
  messagingSenderId: '551762063993',
  functionsRegion: 'us-central1',
  recaptchaSiteKey: '6LffLiAuAAAAAFArUuFKreQKRm9BLvnZhFJehrJt',
};

import { GoogleGenAI } from '@google/genai';

function resolveGeminiApiKey(): string {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key || key === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return key;
}

export function isGeminiConfigured(): boolean {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = resolveGeminiApiKey();
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function generateAiChatReply(
  userMessage: string,
  senderName = 'Friend'
): Promise<string> {
  const ai = getGeminiClient();
  const prompt = userMessage.trim().slice(0, 2000);
  if (!prompt) {
    throw new Error('Empty message for AI reply.');
  }

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: [
      {
        role: 'user',
        parts: [{ text: `User (${senderName}): ${prompt}` }],
      },
    ],
    config: {
      systemInstruction:
        'You are a helpful, polite WhatsApp assistant. Reply concisely and naturally in the same language as the user (English, Urdu, or Roman Urdu). Keep replies short and clear for WhatsApp chat.',
    },
  });

  const text = (response.text || '').trim();
  if (!text) {
    throw new Error('AI model returned an empty response.');
  }
  return text;
}

export async function synthesizePakistaniFemaleTts(rawText: string): Promise<Buffer> {
  const ai = getGeminiClient();
  const cleanText = rawText.trim().slice(0, 650);
  if (!cleanText) {
    throw new Error('Text is required for TTS synthesis.');
  }

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash-tts',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: cleanText,
            speechMetadata: {
              style:
                'Warm, natural, expressive young Pakistani woman speaking Urdu, Roman Urdu, and English fluently with authentic Pakistani pronunciation and clear conversational cadence',
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Kore' },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('Gemini TTS did not return audio data.');
  }
  return Buffer.from(base64Audio, 'base64');
}

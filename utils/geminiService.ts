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

async function runGeminiTextTask(systemInstruction: string, prompt: string): Promise<string> {
  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 12_000) }] }],
    config: { systemInstruction },
  });
  const text = (response.text || '').trim();
  if (!text) {
    throw new Error('AI model returned an empty response.');
  }
  return text;
}

export async function generateFactCheckReply(claim: string): Promise<string> {
  return runGeminiTextTask(
    'You are an objective fact-checker for WhatsApp chats. Evaluate the claim clearly using WhatsApp markdown. Start with a bold Verdict (Likely True / Misleading / False / Needs Context / Unverified), then give 2-3 concise bullet points explaining why and noting any misinformation risks. Keep total output under 180 words.',
    `Fact-check this claim:\n${claim}`
  );
}

export async function generateGroupSummary(transcript: string, msgCount: number): Promise<string> {
  return runGeminiTextTask(
    'You summarize WhatsApp group chat conversations clearly in concise bullet points. Highlight main topics discussed, key decisions/questions, and important updates. Match the dominant language (English/Urdu/Roman Urdu) and keep total output under 220 words.',
    `Summarize these recent ${msgCount} group messages:\n\n${transcript}`
  );
}

export async function generateGrammarCorrection(text: string): Promise<string> {
  return runGeminiTextTask(
    'You are an expert English and Urdu/Roman Urdu editor. Check the text for grammar, spelling, punctuation, and clarity. Return:\n1) *Corrected Version:* (clean corrected text)\n2) *Notes:* (1-3 short bullet points on key fixes made, or "No errors found" if already clean). Keep concise for WhatsApp.',
    `Check and correct grammar/spelling/phrasing:\n${text}`
  );
}

export async function generatePlayfulRoast(targetName: string): Promise<string> {
  return runGeminiTextTask(
    'Write a short, witty, playful, lighthearted roast (2-3 sentences max) about the named friend for a WhatsApp group. Keep it clever, funny, and strictly friendly/non-abusive (no slurs, hate, profanity, or harassment).',
    `Roast "${targetName}" playfully.`
  );
}

export async function generatePoetryReply(topicOrMood: string): Promise<string> {
  return runGeminiTextTask(
    'You are an eloquent poet fluent in Urdu shayari (both Urdu script and Roman Urdu) and English poetry. If the user writes in English or requests English poetry, write evocative English verse; otherwise write heartfelt, rhythmic Roman Urdu or Urdu shayari (4-6 lines) with a poetic title line. Format cleanly for WhatsApp without meta commentary.',
    `Write poetry/shayari matching this theme, mood, or request:\n${topicOrMood}`
  );
}

export async function generateBioOptionsReply(keywordsOrRole: string): Promise<string> {
  return runGeminiTextTask(
    'You craft stylish, concise, memorable profile bios for WhatsApp, Instagram, and TikTok. Return 4 distinct numbered bio options (1-2 short lines each) with tasteful emojis matching the user’s keywords/vibe (e.g., Clean/Minimal, Attitude, Creative, Aesthetic). Keep each bio under 140 characters and skip extra chatter.',
    `Generate 4 stylish social profile bios for these keywords/profile details:\n${keywordsOrRole}`
  );
}


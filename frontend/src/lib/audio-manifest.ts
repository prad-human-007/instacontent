export const AUDIO_FILES = ["reelAudio1.mp3"] as const;

export type AudioFile = (typeof AUDIO_FILES)[number];

export function isAudioFile(value: unknown): value is AudioFile {
	return typeof value === "string" && AUDIO_FILES.some((file) => file === value);
}

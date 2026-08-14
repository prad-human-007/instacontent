import { NextResponse } from "next/server";

import { AUDIO_FILES } from "@/lib/audio-manifest";

export async function GET() {
	return NextResponse.json({ audios: AUDIO_FILES });
}

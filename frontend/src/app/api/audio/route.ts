import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
	try {
		const audioDir = path.join(process.cwd(), "public", "audio");
		if (fs.existsSync(audioDir)) {
			const files = fs.readdirSync(audioDir);
			const audios = files.filter((file) =>
				/\.(mp3|wav|ogg|m4a|aac)$/i.test(file),
			);
			if (audios.length > 0) {
				return NextResponse.json({ audios });
			}
		}
	} catch {
		// Ignore error and fall back to default
	}

	return NextResponse.json({ audios: ["reelAudio1.mp3"] });
}

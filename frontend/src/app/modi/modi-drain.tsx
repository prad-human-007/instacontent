"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./modi.module.css";

const FRAME_SRC = "/modi/modi-frame.png";
const INITIAL_FILL_TOP = 0;
const DRAIN_DURATION_MS = 6000;
const EXTRA_HOLD_MS = 2000;
const LINE_ALPHA_THRESHOLD = 24;
const FILL_COLOUR = [244, 185, 64] as const;

type Phase = "loading" | "ready" | "running" | "complete" | "error";
type ExportState = "idle" | "preparing" | "recording" | "converting" | "downloading";
type PublishingState =
	| "idle"
	| "video_ready"
	| "uploading_video"
	| "preparing_reel"
	| "instagram_processing"
	| "publishing"
	| "published"
	| "failed";

type GeneratedVideo = {
	exportId: string;
	filename: string;
	size: number;
};

type RenderAssets = {
	fillMask: HTMLCanvasElement;
	frame: HTMLImageElement;
	height: number;
	width: number;
};

function createFillMask(framePixels: ImageData, width: number, height: number) {
	const pixelCount = width * height;
	const outside = new Uint8Array(pixelCount);
	const queue = new Int32Array(pixelCount);
	let queueStart = 0;
	let queueEnd = 0;

	const visit = (pixelIndex: number) => {
		if (outside[pixelIndex] || framePixels.data[pixelIndex * 4 + 3] > LINE_ALPHA_THRESHOLD) {
			return;
		}

		outside[pixelIndex] = 1;
		queue[queueEnd] = pixelIndex;
		queueEnd += 1;
	};

	for (let x = 0; x < width; x += 1) {
		visit(x);
		visit((height - 1) * width + x);
	}

	for (let y = 1; y < height - 1; y += 1) {
		visit(y * width);
		visit(y * width + width - 1);
	}

	while (queueStart < queueEnd) {
		const pixelIndex = queue[queueStart];
		const x = pixelIndex % width;
		queueStart += 1;

		if (x > 0) visit(pixelIndex - 1);
		if (x < width - 1) visit(pixelIndex + 1);
		if (pixelIndex >= width) visit(pixelIndex - width);
		if (pixelIndex < pixelCount - width) visit(pixelIndex + width);
	}

	const maskCanvas = document.createElement("canvas");
	maskCanvas.width = width;
	maskCanvas.height = height;

	const maskContext = maskCanvas.getContext("2d");
	if (!maskContext) {
		throw new Error("Canvas is not available.");
	}

	const maskPixels = maskContext.createImageData(width, height);

	for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
		if (outside[pixelIndex]) continue;

		const channelIndex = pixelIndex * 4;
		maskPixels.data[channelIndex] = FILL_COLOUR[0];
		maskPixels.data[channelIndex + 1] = FILL_COLOUR[1];
		maskPixels.data[channelIndex + 2] = FILL_COLOUR[2];
		maskPixels.data[channelIndex + 3] = 255;
	}

	maskContext.putImageData(maskPixels, 0, 0);
	return maskCanvas;
}

const LOCAL_STORAGE_KEY_START = "modi_start_date";
const LOCAL_STORAGE_KEY_CURRENT = "modi_current_date";
const LOCAL_STORAGE_KEY_END = "modi_end_date";

const DEFAULT_START_DATE = "2024-06-09";
const DEFAULT_END_DATE = "2029-06-09";

function getTodayString() {
	const d = new Date();
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function parseDateString(dateStr: string): Date | null {
	if (!dateStr || typeof dateStr !== "string") return null;
	const str = dateStr.trim();

	const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
	if (ymdMatch) {
		const year = parseInt(ymdMatch[1], 10);
		const month = parseInt(ymdMatch[2], 10) - 1;
		const day = parseInt(ymdMatch[3], 10);
		const d = new Date(Date.UTC(year, month, day));
		return Number.isNaN(d.getTime()) ? null : d;
	}

	const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
	if (dmyMatch) {
		const day = parseInt(dmyMatch[1], 10);
		const month = parseInt(dmyMatch[2], 10) - 1;
		const year = parseInt(dmyMatch[3], 10);
		const d = new Date(Date.UTC(year, month, day));
		return Number.isNaN(d.getTime()) ? null : d;
	}

	const ts = Date.parse(str);
	if (!Number.isNaN(ts)) {
		return new Date(ts);
	}

	return null;
}

function calculateTargetPercentage(start: string, current: string, end: string) {
	const startDateObj = parseDateString(start);
	const currentDateObj = parseDateString(current);
	const endDateObj = parseDateString(end);

	if (!startDateObj || !currentDateObj || !endDateObj) {
		return 0;
	}

	const startMs = startDateObj.getTime();
	const currentMs = currentDateObj.getTime();
	const endMs = endDateObj.getTime();

	if (endMs <= startMs) {
		return 0;
	}

	const totalDuration = endMs - startMs;
	const elapsed = currentMs - startMs;
	const fraction = elapsed / totalDuration;
	return Math.max(0, Math.min(100, fraction * 100));
}

function formatDateLong(dateStr: string): string {
	const d = parseDateString(dateStr);
	if (!d) return dateStr;
	const day = d.getUTCDate();
	const monthNames = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const month = monthNames[d.getUTCMonth()];
	const year = d.getUTCFullYear();
	return `${day} ${month} ${year}`;
}

function getJourneyFractionPhrase(pct: number): string {
	const benchmarks = [
		{ threshold: 90, label: "nine-tenths" },
		{ threshold: 80, label: "four-fifths" },
		{ threshold: 75, label: "three-quarters" },
		{ threshold: 66.67, label: "two-thirds" },
		{ threshold: 60, label: "three-fifths" },
		{ threshold: 50, label: "half" },
		{ threshold: 40, label: "two-fifths" },
		{ threshold: 33.33, label: "one-third" },
		{ threshold: 25, label: "one-quarter" },
		{ threshold: 20, label: "one-fifth" },
		{ threshold: 10, label: "one-tenth" },
	];

	for (const b of benchmarks) {
		if (Math.abs(pct - b.threshold) < 0.01) {
			return `${b.label}`;
		}
		if (pct > b.threshold) {
			return `more than ${b.label}`;
		}
	}
	return "less than one-tenth";
}

function generateDefaultCaption(startStr: string, currentStr: string, endStr: string): string {
	const formattedDate = formatDateLong(currentStr || getTodayString());
	const pct = calculateTargetPercentage(startStr, currentStr, endStr);
	const completedPctStr = pct.toFixed(2);
	const remainingPctStr = Math.max(0, 100 - pct).toFixed(2);

	const startDateObj = parseDateString(startStr);
	const currentDateObj = parseDateString(currentStr);
	const endDateObj = parseDateString(endStr);

	let elapsedDays = 0;
	let totalDays = 0;

	if (startDateObj && currentDateObj && endDateObj) {
		const startMs = startDateObj.getTime();
		const currentMs = currentDateObj.getTime();
		const endMs = endDateObj.getTime();

		totalDays = Math.max(1, Math.round((endMs - startMs) / (1000 * 60 * 60 * 24)));
		elapsedDays = Math.max(0, Math.min(totalDays, Math.round((currentMs - startMs) / (1000 * 60 * 60 * 24))));
	}

	const fractionPhrase = getJourneyFractionPhrase(pct);

	return `${formattedDate}

PM Modi’s third term is ${completedPctStr}% complete 🧭
⏳ Day ${elapsedDays.toLocaleString()} of ${totalDays.toLocaleString()} — ${fractionPhrase} of the journey has passed.
🟡 ${remainingPctStr}% of the projected term remains.

#ModiPercent #NeutralCountdown #ProgressTracker #PMModi #modi`;
}

function drawOffscreenCard(
	ctx: CanvasRenderingContext2D,
	fillTop: number,
	percentage: number,
	assets: RenderAssets,
	portraitCanvas: HTMLCanvasElement,
) {
	const width = 1080;
	const height = 1920;

	// Black 9:16 background
	ctx.fillStyle = "#000000";
	ctx.fillRect(0, 0, width, height);

	// Header Text layout - matching 1:1 web UI proportions (scale factor ~2.82x for 1080x1920)
	ctx.textBaseline = "top";

	// Title Main: "PM Modi’s Term is"
	ctx.font = "800 78px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
	ctx.fillStyle = "#ffffff";
	ctx.textAlign = "center";
	const titleMainY = 192;
	ctx.fillText("PM Modi’s Term is", width / 2, titleMainY);

	// Title Sub: ${percentage}% Completed
	ctx.font = "800 78px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
	const pctText = `${percentage.toFixed(2)}%`;
	const compText = " Completed";

	const pctWidth = ctx.measureText(pctText).width;
	const compWidth = ctx.measureText(compText).width;
	const totalWidth = pctWidth + compWidth;
	const startX = width / 2 - totalWidth / 2;
	const titleSubY = 290;

	ctx.textAlign = "left";
	ctx.fillStyle = "#f4b940";
	ctx.fillText(pctText, startX, titleSubY);

	ctx.fillStyle = "#ffffff";
	ctx.fillText(compText, startX + pctWidth, titleSubY);

	// Render portrait frame onto portraitCanvas
	const pCtx = portraitCanvas.getContext("2d");
	if (pCtx) {
		const top = Math.max(0, Math.min(assets.height, Math.round(fillTop)));
		pCtx.fillStyle = "#000000";
		pCtx.fillRect(0, 0, assets.width, assets.height);

		if (top < assets.height) {
			pCtx.drawImage(
				assets.fillMask,
				0,
				top,
				assets.width,
				assets.height - top,
				0,
				top,
				assets.width,
				assets.height - top,
			);
		}

		pCtx.drawImage(assets.frame, 0, 0, assets.width, assets.height);
	}

	// Fit portrait inside canvas container (matching .canvasContainer padding: 0 45px 68px 45px)
	const containerX = 45;
	const containerY = 412;
	const containerW = width - 2 * containerX; // 990px
	const containerH = height - containerY - 68; // 1532px

	const scale = Math.min(containerW / assets.width, containerH / assets.height);

	const dstW = assets.width * scale;
	const dstH = assets.height * scale;
	const dstX = containerX + (containerW - dstW) / 2;
	const dstY = containerY + (containerH - dstH) / 2;

	ctx.drawImage(portraitCanvas, dstX, dstY, dstW, dstH);
}

async function isMp4Container(blob: Blob): Promise<boolean> {
	const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	return (
		header.length >= 12 &&
		header[4] === 0x66 &&
		header[5] === 0x74 &&
		header[6] === 0x79 &&
		header[7] === 0x70
	);
}

async function normalizeRecordingToMp4(recordedBlob: Blob): Promise<Blob> {
	const { FFmpeg } = await import("@ffmpeg/ffmpeg");
	const { fetchFile, toBlobURL } = await import("@ffmpeg/util");

	const ffmpeg = new FFmpeg();
	const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

	await ffmpeg.load({
		coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
		wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
	});

	const inputIsMp4 = await isMp4Container(recordedBlob);
	const inputName = inputIsMp4 ? "input.mp4" : "input.webm";
	const outputName = "output.mp4";
	const recordedMimeType = recordedBlob.type.toLowerCase();
	const canCopyInstagramCodecs =
		inputIsMp4 &&
		/(?:avc1|h264)/.test(recordedMimeType) &&
		/(?:mp4a|aac)/.test(recordedMimeType);

	await ffmpeg.writeFile(inputName, await fetchFile(recordedBlob));

	if (canCopyInstagramCodecs) {
		// Safari/iOS MediaRecorder can return fragmented MP4. Flatten it into
		// a regular fast-start MP4 while preserving its H.264/AAC streams.
		await ffmpeg.exec([
			"-fflags",
			"+genpts",
			"-i",
			inputName,
			"-map",
			"0:v:0",
			"-map",
			"0:a:0?",
			"-c",
			"copy",
			"-avoid_negative_ts",
			"make_zero",
			"-map_metadata",
			"-1",
			"-movflags",
			"+faststart",
			outputName,
		]);
	} else {
		await ffmpeg.exec([
			"-fflags",
			"+genpts",
			"-i",
			inputName,
			"-map",
			"0:v:0",
			"-map",
			"0:a:0?",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"23",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-pix_fmt",
			"yuv420p",
			"-r",
			"30",
			"-avoid_negative_ts",
			"make_zero",
			"-map_metadata",
			"-1",
			"-movflags",
			"+faststart",
			outputName,
		]);
	}

	const data = await ffmpeg.readFile(outputName);
	const mp4Blob = new Blob([data as unknown as BlobPart], { type: "video/mp4" });

	try {
		await ffmpeg.deleteFile(inputName);
		await ffmpeg.deleteFile(outputName);
		ffmpeg.terminate();
	} catch {
		// Ignore cleanup error
	}

	return mp4Blob;
}

function getExportLabel(state: ExportState): string {
	switch (state) {
		case "preparing":
			return "Preparing…";
		case "recording":
			return "Recording…";
		case "converting":
			return "Converting…";
		case "downloading":
			return "Finalizing…";
		default:
			return "Generate Video";
	}
}

function getPublishingLabel(state: PublishingState): string {
	switch (state) {
		case "uploading_video":
			return "Uploading video…";
		case "preparing_reel":
			return "Preparing Reel…";
		case "instagram_processing":
			return "Instagram processing…";
		case "publishing":
			return "Publishing…";
		case "published":
			return "Published successfully";
		default:
			return "Post to Instagram";
	}
}

async function createExportId(blob: Blob): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export default function ModiDrain() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const portraitRef = useRef<HTMLDivElement>(null);
	const assetsRef = useRef<RenderAssets | null>(null);
	const animationFrameRef = useRef<number | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const generatedVideoBlobRef = useRef<Blob | null>(null);
	const isCaptionUserEdited = useRef<boolean>(false);

	const [phase, setPhase] = useState<Phase>("loading");
	const [percentage, setPercentage] = useState<number>(0);

	const [startDate, setStartDate] = useState<string>(DEFAULT_START_DATE);
	const [currentDate, setCurrentDate] = useState<string>(getTodayString());
	const [endDate, setEndDate] = useState<string>(DEFAULT_END_DATE);
	const [isLoaded, setIsLoaded] = useState<boolean>(false);

	const [audioList, setAudioList] = useState<string[]>(["reelAudio1.mp3"]);
	const [selectedAudio, setSelectedAudio] = useState<string>("reelAudio1.mp3");

	const [exportState, setExportState] = useState<ExportState>("idle");
	const [exportError, setExportError] = useState<string | null>(null);
	const [generatedVideo, setGeneratedVideo] = useState<GeneratedVideo | null>(null);
	const [caption, setCaption] = useState<string>("");
	const [publishingState, setPublishingState] = useState<PublishingState>("idle");
	const [publishingMessage, setPublishingMessage] = useState<string | null>(null);
	const [publishedMediaId, setPublishedMediaId] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/audio")
			.then((res) => res.json() as Promise<{ audios?: string[] }>)
			.then((data) => {
				if (data?.audios && Array.isArray(data.audios) && data.audios.length > 0) {
					const list = data.audios;
					setAudioList(list);
					setSelectedAudio((prev) => (list.includes(prev) ? prev : list[0]));
				}
			})
			.catch(() => {});
	}, []);


	useEffect(() => {
		const savedStart = localStorage.getItem(LOCAL_STORAGE_KEY_START);
		const savedCurrent = localStorage.getItem(LOCAL_STORAGE_KEY_CURRENT);
		const savedEnd = localStorage.getItem(LOCAL_STORAGE_KEY_END);

		if (savedStart) setStartDate(savedStart);
		if (savedCurrent) setCurrentDate(savedCurrent);
		else setCurrentDate(getTodayString());
		if (savedEnd) setEndDate(savedEnd);

		setIsLoaded(true);
	}, []);

	useEffect(() => {
		if (!isLoaded) return;
		localStorage.setItem(LOCAL_STORAGE_KEY_START, startDate);
		localStorage.setItem(LOCAL_STORAGE_KEY_CURRENT, currentDate);
		localStorage.setItem(LOCAL_STORAGE_KEY_END, endDate);
	}, [startDate, currentDate, endDate, isLoaded]);

	const stopAudio = useCallback(() => {
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current.currentTime = 0;
			audioRef.current = null;
		}
	}, []);

	const paint = useCallback((fillTop: number) => {
		const canvas = canvasRef.current;
		const assets = assetsRef.current;
		if (!canvas || !assets) return;

		const context = canvas.getContext("2d");
		if (!context) return;

		const top = Math.max(0, Math.min(assets.height, Math.round(fillTop)));

		context.fillStyle = "#000000";
		context.fillRect(0, 0, assets.width, assets.height);

		if (top < assets.height) {
			context.drawImage(
				assets.fillMask,
				0,
				top,
				assets.width,
				assets.height - top,
				0,
				top,
				assets.width,
				assets.height - top,
			);
		}

		context.drawImage(assets.frame, 0, 0, assets.width, assets.height);
	}, []);

	const resetPortrait = useCallback(() => {
		stopAudio();
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = null;
		}
		const assets = assetsRef.current;
		if (assets) {
			paint(assets.height * INITIAL_FILL_TOP);
			setPercentage(0);
			setPhase("ready");
		}
	}, [paint, stopAudio]);

	const startDrain = useCallback(() => {
		const assets = assetsRef.current;
		if (!assets || phase === "loading" || phase === "running" || phase === "error" || exportState !== "idle") return;

		stopAudio();

		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = null;
		}

		const completedPercentage = calculateTargetPercentage(startDate, currentDate, endDate);

		const startLevel = assets.height * INITIAL_FILL_TOP;
		const targetLevel = assets.height * (completedPercentage / 100);

		const portrait = portraitRef.current;
		if (portrait) {
			const bounds = portrait.getBoundingClientRect();
			if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
				// On iOS, animation frames can pause during manual scrolling and
				// resume with a large timestamp jump. Move the result into view
				// synchronously so playback starts from its first visible frame.
				portrait.scrollIntoView({ behavior: "auto", block: "start" });
			}
		}

		paint(startLevel);
		setPercentage(0);

		const audio = new Audio(`/audio/${selectedAudio}`);
		audioRef.current = audio;

		const runAnimationWithDuration = (durationMs: number) => {
			audio.play().catch(() => {});
			setPhase("running");
			let startedAt: number | null = null;

			const animate = (time: number) => {
				if (startedAt === null) {
					startedAt = time;
				}
				const elapsedMs = time - startedAt;
				const progress = Math.min(elapsedMs / durationMs, 1);
				const fillTop = startLevel + (targetLevel - startLevel) * progress;
				paint(fillTop);
				setPercentage(progress * completedPercentage);

				if (elapsedMs < durationMs + EXTRA_HOLD_MS) {
					animationFrameRef.current = requestAnimationFrame(animate);
					return;
				}

				animationFrameRef.current = null;
				setPhase("complete");
			};

			animationFrameRef.current = requestAnimationFrame(animate);
		};

		if (audio.readyState >= 1 && audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
			runAnimationWithDuration(audio.duration * 1000);
		} else {
			const onMetadata = () => {
				audio.removeEventListener("loadedmetadata", onMetadata);
				const duration =
					audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)
						? audio.duration * 1000
						: DRAIN_DURATION_MS;
				runAnimationWithDuration(duration);
			};
			const onError = () => {
				audio.removeEventListener("error", onError);
				runAnimationWithDuration(DRAIN_DURATION_MS);
			};
			audio.addEventListener("loadedmetadata", onMetadata);
			audio.addEventListener("error", onError);
		}
	}, [paint, phase, startDate, currentDate, endDate, selectedAudio, stopAudio, exportState]);

	const exportVideo = async () => {
		if (
			exportState !== "idle" ||
			phase === "loading" ||
			phase === "error" ||
			["uploading_video", "preparing_reel", "instagram_processing", "publishing"].includes(
				publishingState,
			)
		)
			return;

		setExportError(null);
		setPublishingMessage(null);
		setPublishedMediaId(null);
		setPublishingState("idle");
		setGeneratedVideo(null);
		generatedVideoBlobRef.current = null;
		setExportState("preparing");
		stopAudio();
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = null;
		}

		let audioCtx: AudioContext | null = null;
		let combinedStream: MediaStream | null = null;
		let mediaRecorder: MediaRecorder | null = null;

		try {
			const AudioContextClass =
				window.AudioContext ||
				(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			audioCtx = new AudioContextClass();
			if (audioCtx.state === "suspended") {
				await audioCtx.resume();
			}

			if (typeof document !== "undefined" && document.fonts) {
				await document.fonts.ready;
			}

			const assets = assetsRef.current;
			if (!assets) {
				throw new Error("Portrait assets are not loaded yet.");
			}

			const audioResponse = await fetch(`/audio/${selectedAudio}`);
			if (!audioResponse.ok) {
				throw new Error(`Failed to load audio file: ${selectedAudio}`);
			}
			const audioArrayBuffer = await audioResponse.arrayBuffer();

			const audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer);
			const durationSec =
				audioBuffer.duration && audioBuffer.duration > 0
					? audioBuffer.duration
					: DRAIN_DURATION_MS / 1000;
			const durationMs = durationSec * 1000;

			const sourceNode = audioCtx.createBufferSource();
			sourceNode.buffer = audioBuffer;
			const destNode = audioCtx.createMediaStreamDestination();
			sourceNode.connect(destNode);

			const exportCanvas = document.createElement("canvas");
			exportCanvas.width = 1080;
			exportCanvas.height = 1920;
			const ctx = exportCanvas.getContext("2d");
			if (!ctx) throw new Error("Could not get offscreen canvas 2d context.");

			const portraitCanvas = document.createElement("canvas");
			portraitCanvas.width = assets.width;
			portraitCanvas.height = assets.height;

			const canvasStream = exportCanvas.captureStream(30);
			combinedStream = new MediaStream([
				...canvasStream.getVideoTracks(),
				...destNode.stream.getAudioTracks(),
			]);

			const completedPercentage = calculateTargetPercentage(startDate, currentDate, endDate);
			const startLevel = assets.height * INITIAL_FILL_TOP;
			const targetLevel = assets.height * (completedPercentage / 100);

			let mimeType = "";
			const preferredTypes = [
				"video/mp4;codecs=avc1.42E01E,mp4a.40.2",
				"video/mp4;codecs=avc1,mp4a.40.2",
				"video/mp4",
				"video/webm;codecs=vp9,opus",
				"video/webm;codecs=vp8,opus",
				"video/webm",
			];
			for (const t of preferredTypes) {
				if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
					mimeType = t;
					break;
				}
			}

			mediaRecorder = new MediaRecorder(combinedStream, mimeType ? { mimeType } : undefined);
			const chunks: Blob[] = [];
			mediaRecorder.ondataavailable = (e) => {
				if (e.data && e.data.size > 0) {
					chunks.push(e.data);
				}
			};

			const recordingPromise = new Promise<Blob>((resolve, reject) => {
				if (!mediaRecorder) return reject(new Error("MediaRecorder not initialized"));
				mediaRecorder.onstop = () => {
					const recordedBlob = new Blob(chunks, {
						type: mediaRecorder?.mimeType || mimeType || "video/webm",
					});
					resolve(recordedBlob);
				};
				mediaRecorder.onerror = (e) => {
					reject(new Error("MediaRecorder error: " + (e as unknown as Error).message));
				};
			});

			drawOffscreenCard(ctx, startLevel, 0, assets, portraitCanvas);
			paint(startLevel);
			setPercentage(0);

			setExportState("recording");

			mediaRecorder.start();
			sourceNode.start(0);

			await new Promise<void>((resolve) => {
				let recordStartTime: number | null = null;
				const animate = (now: number) => {
					if (recordStartTime === null) {
						recordStartTime = now;
					}
					const elapsedMs = now - recordStartTime;
					const progress = Math.min(elapsedMs / durationMs, 1);
					const fillTop = startLevel + (targetLevel - startLevel) * progress;
					const currentPct = progress * completedPercentage;

					drawOffscreenCard(ctx, fillTop, currentPct, assets, portraitCanvas);
					paint(fillTop);
					setPercentage(currentPct);

					if (elapsedMs < durationMs + EXTRA_HOLD_MS) {
						requestAnimationFrame(animate);
					} else {
						drawOffscreenCard(ctx, targetLevel, completedPercentage, assets, portraitCanvas);
						paint(targetLevel);
						setPercentage(completedPercentage);
						setTimeout(resolve, 100);
					}
				};
				requestAnimationFrame(animate);
			});

			if (mediaRecorder.state === "recording") {
				mediaRecorder.stop();
			}

			const rawBlob = await recordingPromise;

			setExportState("converting");
			const finalMp4Blob = await normalizeRecordingToMp4(rawBlob);

			setExportState("downloading");

			const sanitizedDate = (currentDate || getTodayString()).trim().replace(/[^a-zA-Z0-9-]/g, "-");
			const downloadFilename = `modi-term-progress-${sanitizedDate}.mp4`;
			const exportId = await createExportId(finalMp4Blob);

			generatedVideoBlobRef.current = finalMp4Blob;
			setGeneratedVideo({
				exportId,
				filename: downloadFilename,
				size: finalMp4Blob.size,
			});
			if (!isCaptionUserEdited.current || !caption.trim()) {
				setCaption(generateDefaultCaption(startDate, currentDate, endDate));
			}
			setPublishingState("video_ready");
		} catch (err) {
			console.error("Export error:", err);
			setExportError((err as Error).message || "Export failed. Please try again.");
		} finally {
			if (combinedStream) {
				combinedStream.getTracks().forEach((track) => track.stop());
			}
			if (audioCtx && audioCtx.state !== "closed") {
				try {
					await audioCtx.close();
				} catch {}
			}
			resetPortrait();
			setExportState("idle");
		}
	};

	const saveVideoLocally = useCallback(() => {
		const blob = generatedVideoBlobRef.current;
		if (!blob || !generatedVideo) return;
		const downloadUrl = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = downloadUrl;
		a.download = generatedVideo.filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => {
			URL.revokeObjectURL(downloadUrl);
		}, 10000);
	}, [generatedVideo]);

	const postToInstagram = async () => {
		const videoBlob = generatedVideoBlobRef.current;
		if (
			!generatedVideo ||
			!videoBlob ||
			!caption.trim() ||
			["uploading_video", "preparing_reel", "instagram_processing", "publishing"].includes(
				publishingState,
			)
		) {
			return;
		}

		setPublishingMessage(null);
		setPublishedMediaId(null);
		setPublishingState("uploading_video");

		try {
			const formData = new FormData();
			formData.append("video", videoBlob, generatedVideo.filename);
			formData.append("caption", caption.trim());
			formData.append("exportId", generatedVideo.exportId);

			const response = await fetch("/api/instagram/publish", {
				method: "POST",
				body: formData,
			});

			const responseContentType = response.headers.get("content-type") ?? "";
			if (!response.ok && responseContentType.includes("application/json")) {
				const body = (await response.json().catch(() => null)) as {
					error?: { message?: unknown };
				} | null;
				throw new Error(
					typeof body?.error?.message === "string"
						? body.error.message
						: "Instagram publishing request failed.",
				);
			}

			if (!response.body) {
				throw new Error("Instagram publishing request failed.");
			}
			if (!responseContentType.includes("application/x-ndjson")) {
				throw new Error(
					"Instagram publishing is unavailable. Sign in through Cloudflare Access and try again.",
				);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let published = false;

			const handleLine = (line: string) => {
				if (!line.trim()) return;
				const event = JSON.parse(line) as {
					type?: unknown;
					stage?: unknown;
					mediaId?: unknown;
					message?: unknown;
				};

				if (
					event.type === "stage" &&
					(event.stage === "preparing_reel" ||
						event.stage === "instagram_processing" ||
						event.stage === "publishing")
				) {
					setPublishingState(event.stage);
					return;
				}
				if (event.type === "published" && typeof event.mediaId === "string") {
					published = true;
					setPublishedMediaId(event.mediaId);
					setPublishingMessage("Reel published to @pmmodiprogressbar.");
					setPublishingState("published");
					return;
				}
				if (event.type === "error") {
					throw new Error(
						typeof event.message === "string"
							? event.message
							: "Instagram publishing failed.",
					);
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
				if (done) break;
			}
			if (buffer.trim()) handleLine(buffer);
			if (!published) {
				throw new Error("Instagram publishing ended without confirmation.");
			}
		} catch (error) {
			setPublishingState("failed");
			setPublishingMessage(
				error instanceof Error
					? error.message
					: "Instagram publishing failed. Export again before retrying.",
			);
		}
	};

	useEffect(() => {
		let cancelled = false;
		const frame = new Image();
		frame.decoding = "async";

		const loadFrame = async () => {
			try {
				frame.src = FRAME_SRC;
				await frame.decode();
				if (cancelled) return;

				const frameCanvas = document.createElement("canvas");
				frameCanvas.width = frame.naturalWidth;
				frameCanvas.height = frame.naturalHeight;

				const frameContext = frameCanvas.getContext("2d", { willReadFrequently: true });
				if (!frameContext) {
					throw new Error("Canvas is not available.");
				}

				frameContext.drawImage(frame, 0, 0);
				const framePixels = frameContext.getImageData(0, 0, frame.naturalWidth, frame.naturalHeight);
				const fillMask = createFillMask(framePixels, frame.naturalWidth, frame.naturalHeight);

				assetsRef.current = {
					fillMask,
					frame,
					height: frame.naturalHeight,
					width: frame.naturalWidth,
				};

				const canvas = canvasRef.current;
				if (canvas) {
					canvas.width = frame.naturalWidth;
					canvas.height = frame.naturalHeight;
				}

				paint(frame.naturalHeight * INITIAL_FILL_TOP);
				setPercentage(0);
				setPhase("ready");
			} catch {
				if (!cancelled) setPhase("error");
			}
		};

		void loadFrame();

		return () => {
			cancelled = true;
			stopAudio();
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current);
			}
		};
	}, [paint, stopAudio]);

	const isPublishing =
		publishingState === "uploading_video" ||
		publishingState === "preparing_reel" ||
		publishingState === "instagram_processing" ||
		publishingState === "publishing";
	const isDisabled = phase === "running" || exportState !== "idle" || isPublishing;

	return (
		<main className={styles.page}>
			<section className={styles.experience}>
				<div
					ref={portraitRef}
					className={styles.portrait}
					aria-busy={phase === "loading" || exportState !== "idle"}
				>
					<div className={styles.header}>
						<h1 className={styles.titleMain}>PM Modi’s Term is</h1>
						<h2 className={styles.titleSub}>
							<span className={styles.percentText}>{percentage.toFixed(2)}%</span>
							<span>Completed</span>
						</h2>
					</div>

					<div className={styles.canvasContainer}>
						<canvas
							ref={canvasRef}
							className={styles.canvas}
							role="img"
							aria-label="White line portrait animation"
						/>
						{phase === "loading" && <span className={styles.loading}>Preparing portrait…</span>}
					</div>
				</div>

				<div className={styles.controls}>
					<div className={styles.dateGroup}>
						<div className={styles.inputField}>
							<label htmlFor="audioSelect" className={styles.label}>
								Select Audio
							</label>
							<select
								id="audioSelect"
								className={styles.selectInput}
								value={selectedAudio}
								onChange={(e) => setSelectedAudio(e.target.value)}
								disabled={isDisabled}
							>
								{audioList.map((file) => (
									<option key={file} value={file}>
										{file}
									</option>
								))}
							</select>
						</div>

						<div className={styles.inputField}>
							<label htmlFor="startDate" className={styles.label}>
								Start Date
							</label>
							<input
								id="startDate"
								type="date"
								className={styles.dateInput}
								value={startDate}
								onChange={(e) => setStartDate(e.target.value)}
								disabled={isDisabled}
							/>
						</div>

						<div className={styles.inputField}>
							<label htmlFor="currentDate" className={styles.label}>
								Current Date
							</label>
							<input
								id="currentDate"
								type="date"
								className={styles.dateInput}
								value={currentDate}
								onChange={(e) => setCurrentDate(e.target.value)}
								disabled={isDisabled}
							/>
						</div>

						<div className={styles.inputField}>
							<label htmlFor="endDate" className={styles.label}>
								End Date
							</label>
							<input
								id="endDate"
								type="date"
								className={styles.dateInput}
								value={endDate}
								onChange={(e) => setEndDate(e.target.value)}
								disabled={isDisabled}
							/>
						</div>
					</div>

					<div className={styles.buttonGroup}>
						<button
							className={styles.button}
							type="button"
							onClick={startDrain}
							disabled={phase === "loading" || phase === "running" || phase === "error" || exportState !== "idle"}
						>
							<span aria-hidden="true">▶</span>
							Play
						</button>

						<button
							className={styles.buttonSecondary}
							type="button"
							onClick={resetPortrait}
							disabled={phase === "loading" || phase === "error" || exportState !== "idle"}
						>
							<span aria-hidden="true">↺</span>
							Reset
						</button>

						<button
							className={styles.buttonExport}
							type="button"
							onClick={exportVideo}
							disabled={phase === "loading" || phase === "running" || phase === "error" || exportState !== "idle"}
						>
							<span aria-hidden="true">🎬</span>
							{getExportLabel(exportState)}
						</button>

						{generatedVideo && (
							<div className={styles.instagramPanel}>
								<div className={styles.videoReady}>
									<span className={styles.statusDot} aria-hidden="true" />
									Video ready
									<span className={styles.videoSize}>
										{(generatedVideo.size / (1024 * 1024)).toFixed(1)} MB
									</span>
								</div>

								<button
									className={styles.buttonSaveLocal}
									type="button"
									onClick={saveVideoLocally}
								>
									<span aria-hidden="true">💾</span>
									Save Video Locally
								</button>

								<div className={styles.instagramSection}>
									<label htmlFor="instagramCaption" className={styles.label}>
										Instagram caption
									</label>
									<textarea
										id="instagramCaption"
										className={styles.captionInput}
										value={caption}
										maxLength={2200}
										rows={8}
										onChange={(event) => {
											isCaptionUserEdited.current = true;
											setCaption(event.target.value);
										}}
										disabled={isPublishing || publishingState === "published"}
									/>

									<button
										className={styles.buttonInstagram}
										type="button"
										onClick={postToInstagram}
										disabled={
											isPublishing ||
											publishingState === "published" ||
											!caption.trim()
										}
									>
										<span aria-hidden="true">◎</span>
										{getPublishingLabel(publishingState)}
									</button>
								</div>
							</div>
						)}
					</div>

					{exportError && <div className={styles.exportError}>{exportError}</div>}
					{publishingMessage && (
						<div
							className={
								publishingState === "published"
									? styles.publishSuccess
									: styles.exportError
							}
						>
							{publishingMessage}
							{publishedMediaId && (
								<span className={styles.mediaId}>Media ID: {publishedMediaId}</span>
							)}
						</div>
					)}
				</div>
			</section>
		</main>
	);
}

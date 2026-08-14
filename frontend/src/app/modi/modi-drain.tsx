"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./modi.module.css";

const FRAME_SRC = "/modi/modi-frame.png";
const INITIAL_FILL_TOP = 0;
const DRAIN_DURATION_MS = 6000;
const EXTRA_HOLD_MS = 2000;
const MAX_GENERATED_VIDEO_BYTES = 64 * 1024 * 1024;
const LINE_ALPHA_THRESHOLD = 24;
const FILL_COLOUR = [244, 185, 64] as const;

type Phase = "loading" | "ready" | "running" | "complete" | "error";
type ExportState = "idle" | "preparing" | "encoding" | "downloading";
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
	duration?: number;
};

type WebCodecsCapability = {
	checkedAt: string;
	supported: boolean;
	video: boolean;
	audio: boolean;
	message: string;
};

type AutomationJobPayload = {
	job: {
		kind: "probe" | "publish";
		localDate: string;
		runId: string;
		settings: {
			audioFile: string;
			endDate: string;
			startDate: string;
		};
	};
};

type AutomationBrowserResult = {
	terminal: true;
	state: "probe_complete" | "published" | "failed" | "outcome_unknown";
	capability?: WebCodecsCapability;
	mediaId?: string;
	errorCode?: string;
	errorMessage?: string;
	retrySafe?: boolean;
};

type AutomationStatusResponse = {
	settings: {
		enabled: boolean;
		time: string;
		timeZone: string;
		startDate: string;
		endDate: string;
		audioFile: string;
		updatedAt: string;
	};
	capability: WebCodecsCapability | null;
	activeRun: {
		runId: string;
		state: string;
		errorMessage?: string;
	} | null;
	lastRun: {
		state: string;
		createdAt?: string;
		finishedAt?: string;
		mediaId?: string;
		errorMessage?: string;
	} | null;
	nextRunAt: string | null;
};

declare global {
	interface Window {
		__modiAutomationResult?: AutomationBrowserResult;
	}
}

function formatVideoDuration(seconds: number): string {
	if (!seconds || isNaN(seconds) || seconds <= 0) return "";
	const formatted = seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1);
	return `${formatted}s`;
}

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

async function probeWebCodecs(): Promise<WebCodecsCapability> {
	try {
		const { canEncodeAudio, canEncodeVideo } = await import("mediabunny");
		const [video, audio] = await Promise.all([
			canEncodeVideo("avc", {
				width: 1080,
				height: 1920,
				bitrate: 6_000_000,
				fullCodecString: "avc1.42c02a",
			}),
			canEncodeAudio("aac", {
				numberOfChannels: 2,
				sampleRate: 44_100,
				bitrate: 128_000,
			}),
		]);
		const supported = video && audio;
		return {
			checkedAt: new Date().toISOString(),
			supported,
			video,
			audio,
			message: supported
				? "Cloudflare browser supports native H.264 and AAC WebCodecs encoding."
				: `WebCodecs support missing: ${!video ? "H.264" : ""}${!video && !audio ? " and " : ""}${!audio ? "AAC" : ""}.`,
		};
	} catch {
		return {
			checkedAt: new Date().toISOString(),
			supported: false,
			video: false,
			audio: false,
			message: "WebCodecs is unavailable in this browser.",
		};
	}
}

async function validateGeneratedMp4(
	blob: Blob,
	expectedAudioDuration: number,
	expectedVideoDuration: number,
): Promise<void> {
	if (blob.size > MAX_GENERATED_VIDEO_BYTES) {
		throw new Error("The generated MP4 is larger than Instagram’s 64 MB limit.");
	}
	if (!(await isMp4Container(blob))) {
		throw new Error("WebCodecs produced an invalid MP4 file.");
	}

	const { BlobSource, Input, MP4 } = await import("mediabunny");
	const media = new Input({ formats: [MP4], source: new BlobSource(blob) });
	try {
		if (!(await media.canRead())) throw new Error("The generated MP4 could not be inspected.");
		const [videoTracks, audioTracks] = await Promise.all([
			media.getVideoTracks(),
			media.getAudioTracks(),
		]);
		if (videoTracks.length !== 1 || audioTracks.length !== 1) {
			throw new Error("The generated MP4 must contain one video track and one audio track.");
		}
		const videoTrack = videoTracks[0];
		const audioTrack = audioTracks[0];
		const [videoCodec, audioCodec, width, height, frameRate, videoDuration, audioDuration] =
			await Promise.all([
				videoTrack.getCodec(),
				audioTrack.getCodec(),
				videoTrack.getDisplayWidth(),
				videoTrack.getDisplayHeight(),
				videoTrack.computeFrameRateMetrics(),
				media.computeDuration([videoTrack]),
				media.computeDuration([audioTrack]),
			]);
		if (videoCodec !== "avc" || audioCodec !== "aac") {
			throw new Error("The generated MP4 does not contain H.264 video and AAC audio.");
		}
		if (width !== 1080 || height !== 1920) {
			throw new Error("The generated MP4 is not 1080×1920.");
		}
		if (!frameRate.frameRateIsConstant || Math.abs(frameRate.averageFrameRate - 30) > 0.05) {
			throw new Error("The generated MP4 is not a constant 30 FPS video.");
		}
		if (Math.abs(videoDuration - expectedVideoDuration) > 0.1) {
			throw new Error("The generated MP4 does not include the full final hold.");
		}
		if (Math.abs(audioDuration - expectedAudioDuration) > 0.25) {
			throw new Error("The generated MP4 audio duration is invalid.");
		}
	} finally {
		media.dispose();
	}
}

async function renderVideoWithWebCodecs(input: {
	assets: RenderAssets;
	audioFile: string;
	currentDate: string;
	endDate: string;
	onProgress?: (percentage: number) => void;
	startDate: string;
}): Promise<{ blob: Blob; duration: number }> {
	const capability = await probeWebCodecs();
	if (!capability.supported) throw new Error(capability.message);

	const {
		AudioBufferSource,
		BufferTarget,
		CanvasSource,
		Mp4OutputFormat,
		Output,
	} = await import("mediabunny");
	const audioContext = new AudioContext();
	try {
		const audioResponse = await fetch(`/audio/${encodeURIComponent(input.audioFile)}`);
		if (!audioResponse.ok) throw new Error(`Failed to load audio file: ${input.audioFile}`);
		const audioBuffer = await audioContext.decodeAudioData(await audioResponse.arrayBuffer());
		const animationDuration = audioBuffer.duration > 0
			? audioBuffer.duration
			: DRAIN_DURATION_MS / 1000;
		const totalDuration = animationDuration + EXTRA_HOLD_MS / 1000;
		const frameRate = 30;
		const frameDuration = 1 / frameRate;
		const frameCount = Math.ceil(totalDuration * frameRate);

		const exportCanvas = document.createElement("canvas");
		exportCanvas.width = 1080;
		exportCanvas.height = 1920;
		const context = exportCanvas.getContext("2d");
		if (!context) throw new Error("Could not create the export canvas.");
		const portraitCanvas = document.createElement("canvas");
		portraitCanvas.width = input.assets.width;
		portraitCanvas.height = input.assets.height;

		const target = new BufferTarget();
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target,
		});
		const videoSource = new CanvasSource(exportCanvas, {
			codec: "avc",
			bitrate: 6_000_000,
			fullCodecString: "avc1.42c02a",
			keyFrameInterval: 2,
			latencyMode: "quality",
		});
		const audioSource = new AudioBufferSource({
			codec: "aac",
			bitrate: 128_000,
		});
		output.addVideoTrack(videoSource, { frameRate });
		output.addAudioTrack(audioSource);
		await output.start();
		await audioSource.add(audioBuffer);

		const completedPercentage = calculateTargetPercentage(
			input.startDate,
			input.currentDate,
			input.endDate,
		);
		const startLevel = input.assets.height * INITIAL_FILL_TOP;
		const targetLevel = input.assets.height * (completedPercentage / 100);

		for (let frame = 0; frame < frameCount; frame += 1) {
			const timestamp = frame * frameDuration;
			const progress = Math.min(timestamp / animationDuration, 1);
			const fillTop = startLevel + (targetLevel - startLevel) * progress;
			const currentPercentage = completedPercentage * progress;
			drawOffscreenCard(
				context,
				fillTop,
				currentPercentage,
				input.assets,
				portraitCanvas,
			);
			await videoSource.add(timestamp, frameDuration, { keyFrame: frame % (frameRate * 2) === 0 });
			if (frame % 10 === 0 || frame === frameCount - 1) {
				input.onProgress?.(currentPercentage);
			}
		}
		await output.finalize();
		if (!target.buffer) throw new Error("WebCodecs did not produce an MP4 file.");
		const outputMimeType = await output.getMimeType();
		if (!/avc1/i.test(outputMimeType) || !/mp4a\.40\.2/i.test(outputMimeType)) {
			throw new Error("WebCodecs did not produce an H.264/AAC MP4 file.");
		}
		const blob = new Blob([target.buffer], { type: "video/mp4" });
		await validateGeneratedMp4(
			blob,
			animationDuration,
			frameCount * frameDuration,
		);
		return { blob, duration: totalDuration };
	} finally {
		if (audioContext.state !== "closed") await audioContext.close().catch(() => {});
	}
}

class PublishingRequestError extends Error {
	constructor(
		message: string,
		readonly code = "INSTAGRAM_PUBLISH_FAILED",
		readonly retrySafe = false,
	) {
		super(message);
	}
}

async function publishVideo(input: {
	blob: Blob;
	caption: string;
	exportId: string;
	filename: string;
	onStage?: (stage: PublishingState) => void | Promise<void>;
}): Promise<string> {
	const formData = new FormData();
	formData.append("video", input.blob, input.filename);
	formData.append("caption", input.caption.trim());
	formData.append("exportId", input.exportId);
	await input.onStage?.("uploading_video");
	const response = await fetch("/api/instagram/publish", { method: "POST", body: formData });
	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok && contentType.includes("application/json")) {
		const body = (await response.json().catch(() => null)) as {
			error?: { code?: unknown; message?: unknown };
		} | null;
		throw new PublishingRequestError(
			typeof body?.error?.message === "string"
				? body.error.message
				: "Instagram publishing request failed.",
			typeof body?.error?.code === "string" ? body.error.code : undefined,
		);
	}
	if (!response.body || !contentType.includes("application/x-ndjson")) {
		throw new PublishingRequestError("Instagram publishing is unavailable.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let mediaId: string | null = null;
	const handleLine = async (line: string) => {
		if (!line.trim()) return;
		const event = JSON.parse(line) as {
			type?: unknown;
			stage?: unknown;
			mediaId?: unknown;
			code?: unknown;
			message?: unknown;
			retrySafe?: unknown;
		};
		if (
			event.type === "stage" &&
			(event.stage === "preparing_reel" ||
				event.stage === "instagram_processing" ||
				event.stage === "publishing")
		) {
			await input.onStage?.(event.stage);
			return;
		}
		if (event.type === "published" && typeof event.mediaId === "string") {
			mediaId = event.mediaId;
			return;
		}
		if (event.type === "error") {
			throw new PublishingRequestError(
				typeof event.message === "string" ? event.message : "Instagram publishing failed.",
				typeof event.code === "string" ? event.code : undefined,
				event.retrySafe === true,
			);
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) await handleLine(line);
		if (done) break;
	}
	if (buffer.trim()) await handleLine(buffer);
	if (!mediaId) throw new PublishingRequestError("Instagram publishing ended without confirmation.");
	return mediaId;
}

function getExportLabel(state: ExportState): string {
	switch (state) {
		case "preparing":
			return "Preparing…";
		case "encoding":
			return "Encoding…";
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
	const automationStartedRef = useRef(false);

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
	const [automationStatus, setAutomationStatus] = useState<AutomationStatusResponse | null>(null);
	const [automationEnabled, setAutomationEnabled] = useState(false);
	const [automationTime, setAutomationTime] = useState("12:00");
	const [automationTimeZone, setAutomationTimeZone] = useState("Asia/Kolkata");
	const [automationBusy, setAutomationBusy] = useState(false);
	const [automationMessage, setAutomationMessage] = useState<string | null>(null);

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
		const savedEnd = localStorage.getItem(LOCAL_STORAGE_KEY_END);

		if (savedStart) setStartDate(savedStart);
		setCurrentDate(getTodayString());
		if (savedEnd) setEndDate(savedEnd);

		setIsLoaded(true);
	}, []);

	useEffect(() => {
		if (!isLoaded) return;
		localStorage.setItem(LOCAL_STORAGE_KEY_START, startDate);
		localStorage.setItem(LOCAL_STORAGE_KEY_CURRENT, currentDate);
		localStorage.setItem(LOCAL_STORAGE_KEY_END, endDate);
	}, [startDate, currentDate, endDate, isLoaded]);

	const loadAutomationStatus = useCallback(async () => {
		if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("automationRunId")) {
			return;
		}
		const response = await fetch("/api/instagram/automation", { cache: "no-store" });
		if (!response.ok) return;
		const data = await response.json() as AutomationStatusResponse;
		setAutomationStatus(data);
		setAutomationEnabled(data.settings.enabled);
		setAutomationTime(data.settings.time);
		const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		setAutomationTimeZone(
			data.settings.updatedAt === new Date(0).toISOString() && browserTimeZone
				? browserTimeZone
				: data.settings.timeZone,
		);
	}, []);

	useEffect(() => {
		void loadAutomationStatus();
	}, [loadAutomationStatus]);

	useEffect(() => {
		if (!automationStatus?.activeRun) return;
		const timer = window.setInterval(() => void loadAutomationStatus(), 3_000);
		return () => window.clearInterval(timer);
	}, [automationStatus?.activeRun, loadAutomationStatus]);

	const saveAutomationSettings = async () => {
		setAutomationBusy(true);
		setAutomationMessage(null);
		try {
			const response = await fetch("/api/instagram/automation", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					enabled: automationEnabled,
					time: automationTime,
					timeZone: automationTimeZone,
					startDate,
					endDate,
					audioFile: selectedAudio,
				}),
			});
			const body = await response.json().catch(() => null) as {
				error?: { message?: unknown };
			} | null;
			if (!response.ok) {
				throw new Error(
					typeof body?.error?.message === "string"
						? body.error.message
						: "Automation settings could not be saved.",
				);
			}
			setAutomationMessage("Automation settings saved.");
			await loadAutomationStatus();
		} catch (error) {
			setAutomationMessage(error instanceof Error ? error.message : "Automation settings failed.");
		} finally {
			setAutomationBusy(false);
		}
	};

	const queueAutomationAction = async (action: "probe" | "publish") => {
		if (
			action === "publish" &&
			!window.confirm("Generate and publish a real Instagram Reel now? Today’s scheduled post will then be skipped.")
		) {
			return;
		}
		setAutomationBusy(true);
		setAutomationMessage(null);
		try {
			const response = await fetch("/api/instagram/automation/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action }),
			});
			const body = await response.json().catch(() => null) as {
				error?: { message?: unknown };
			} | null;
			if (!response.ok) {
				throw new Error(
					typeof body?.error?.message === "string"
						? body.error.message
						: "Automation job could not be queued.",
				);
			}
			setAutomationMessage(
				action === "probe"
					? "Cloudflare WebCodecs check queued. It will start within one minute."
					: "Real Reel queued. It will start within one minute.",
			);
			await loadAutomationStatus();
		} catch (error) {
			setAutomationMessage(error instanceof Error ? error.message : "Automation action failed.");
		} finally {
			setAutomationBusy(false);
		}
	};

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

		try {
			if (typeof document !== "undefined" && document.fonts) {
				await document.fonts.ready;
			}
			const assets = assetsRef.current;
			if (!assets) throw new Error("Portrait assets are not loaded yet.");
			paint(assets.height * INITIAL_FILL_TOP);
			setPercentage(0);
			setExportState("encoding");
			const rendered = await renderVideoWithWebCodecs({
				assets,
				audioFile: selectedAudio,
				currentDate,
				endDate,
				onProgress: setPercentage,
				startDate,
			});
			setExportState("downloading");
			const sanitizedDate = (currentDate || getTodayString()).trim().replace(/[^a-zA-Z0-9-]/g, "-");
			const downloadFilename = `modi-term-progress-${sanitizedDate}.mp4`;
			const exportId = await createExportId(rendered.blob);
			generatedVideoBlobRef.current = rendered.blob;
			setGeneratedVideo({
				exportId,
				filename: downloadFilename,
				size: rendered.blob.size,
				duration: rendered.duration,
			});
			if (!isCaptionUserEdited.current || !caption.trim()) {
				setCaption(generateDefaultCaption(startDate, currentDate, endDate));
			}
			setPublishingState("video_ready");
		} catch (err) {
			console.error("Export error:", err);
			setExportError((err as Error).message || "Export failed. Please try again.");
		} finally {
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
			const mediaId = await publishVideo({
				blob: videoBlob,
				caption,
				exportId: generatedVideo.exportId,
				filename: generatedVideo.filename,
				onStage: setPublishingState,
			});
			setPublishedMediaId(mediaId);
			setPublishingMessage("Reel published to @pmmodiprogressbar.");
			setPublishingState("published");
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

	useEffect(() => {
		if (phase !== "ready" || !isLoaded || automationStartedRef.current) return;
		const runId = new URLSearchParams(window.location.search).get("automationRunId");
		if (!runId) return;
		automationStartedRef.current = true;

		const reportState = async (
			state: string,
			extra?: Record<string, string | boolean>,
		) => {
			const response = await fetch("/api/instagram/automation/job", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state, ...extra }),
			});
			if (!response.ok) throw new Error("Automation status could not be updated.");
		};

		const run = async () => {
			try {
				const response = await fetch("/api/instagram/automation/job", { cache: "no-store" });
				if (!response.ok) throw new Error("Automation job could not be loaded.");
				const { job } = await response.json() as AutomationJobPayload;

				if (job.kind === "probe") {
					await reportState("probing");
					const capability = await probeWebCodecs();
					window.__modiAutomationResult = {
						terminal: true,
						state: "probe_complete",
						capability,
					};
					return;
				}

				const assets = assetsRef.current;
				if (!assets) throw new Error("Portrait assets are not loaded.");
				setStartDate(job.settings.startDate);
				setCurrentDate(job.localDate);
				setEndDate(job.settings.endDate);
				setSelectedAudio(job.settings.audioFile);
				setExportState("encoding");
				await reportState("rendering");
				if (document.fonts) await document.fonts.ready;
				const rendered = await renderVideoWithWebCodecs({
					assets,
					audioFile: job.settings.audioFile,
					currentDate: job.localDate,
					endDate: job.settings.endDate,
					onProgress: setPercentage,
					startDate: job.settings.startDate,
				});
				const filename = `modi-term-progress-${job.localDate}.mp4`;
				const exportId = await createExportId(rendered.blob);
				const automaticCaption = generateDefaultCaption(
					job.settings.startDate,
					job.localDate,
					job.settings.endDate,
				);
				if (!automaticCaption.startsWith(formatDateLong(job.localDate))) {
					throw new Error("The automatic caption date could not be verified.");
				}
				setCaption(automaticCaption);
				setExportState("idle");
				setPublishingState("uploading_video");
				const mediaId = await publishVideo({
					blob: rendered.blob,
					caption: automaticCaption,
					exportId,
					filename,
					onStage: async (state) => {
						setPublishingState(state);
						await reportState(state);
					},
				});
				await reportState("published", { mediaId });
				setPublishingState("published");
				setPublishedMediaId(mediaId);
				window.__modiAutomationResult = {
					terminal: true,
					state: "published",
					mediaId,
				};
			} catch (error) {
				const publishError = error instanceof PublishingRequestError ? error : null;
				const retrySafe = publishError ? publishError.retrySafe : true;
				const outcomeUnknown =
					publishError?.code === "META_PUBLISH_OUTCOME_UNKNOWN" ||
					publishError?.code === "PUBLISH_CONFIRMATION_WRITE_FAILED";
				const state = outcomeUnknown ? "outcome_unknown" : "failed";
				const message = error instanceof Error ? error.message : "Automatic Reel publishing failed.";
				try {
					await reportState(state, {
						errorCode: publishError?.code ?? "AUTOMATION_RENDER_FAILED",
						errorMessage: message,
						retrySafe,
					});
				} catch {}
				setExportState("idle");
				setPublishingState("failed");
				window.__modiAutomationResult = {
					terminal: true,
					state,
					errorCode: publishError?.code ?? "AUTOMATION_RENDER_FAILED",
					errorMessage: message,
					retrySafe,
				};
			}
		};

		void run();
	}, [isLoaded, phase]);

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

					<div className={styles.automationPanel}>
						<div className={styles.automationHeader}>
							<div>
								<span className={styles.label}>Automatic daily Reel</span>
								<div className={styles.automationTitle}>
									{automationEnabled ? "Enabled" : "Disabled"}
								</div>
							</div>
							{automationStatus?.capability?.message && (
								<div>{automationStatus.capability.message}</div>
							)}
							<label className={styles.toggle}>
								<input
									type="checkbox"
									aria-label="Enable automatic daily Reel publishing"
									checked={automationEnabled}
									onChange={(event) => setAutomationEnabled(event.target.checked)}
									disabled={automationBusy}
								/>
								<span aria-hidden="true" />
							</label>
						</div>

						<div className={styles.automationGrid}>
							<div className={styles.inputField}>
								<label htmlFor="automationTime" className={styles.label}>Publish time</label>
								<input
									id="automationTime"
									type="time"
									className={styles.dateInput}
									value={automationTime}
									onChange={(event) => setAutomationTime(event.target.value)}
									disabled={automationBusy}
								/>
							</div>
							<div className={styles.inputField}>
								<label htmlFor="automationTimeZone" className={styles.label}>Timezone</label>
								<input
									id="automationTimeZone"
									className={styles.dateInput}
									value={automationTimeZone}
									onChange={(event) => setAutomationTimeZone(event.target.value)}
									placeholder="Asia/Kolkata"
									disabled={automationBusy}
								/>
							</div>
						</div>

						<div className={styles.automationStatus}>
							<div>
								WebCodecs: {automationStatus?.capability
									? automationStatus.capability.supported ? "Ready" : "Unsupported"
									: "Not checked"}
							</div>
							{automationStatus?.nextRunAt && (
								<div>Next: {new Date(automationStatus.nextRunAt).toLocaleString()}</div>
							)}
							{automationStatus?.activeRun && (
								<div>Current: {automationStatus.activeRun.state.replaceAll("_", " ")}</div>
							)}
							{automationStatus?.activeRun?.errorMessage && (
								<div className={styles.automationError}>{automationStatus.activeRun.errorMessage}</div>
							)}
							{automationStatus?.lastRun && (
								<div>
									Last: {automationStatus.lastRun.state.replaceAll("_", " ")}
									{automationStatus.lastRun.mediaId
										? ` • ${automationStatus.lastRun.mediaId}`
										: ""}
									{automationStatus.lastRun.finishedAt
										? ` • ${new Date(automationStatus.lastRun.finishedAt).toLocaleString()}`
										: ""}
								</div>
							)}
							{automationStatus?.lastRun?.errorMessage && (
								<div className={styles.automationError}>{automationStatus.lastRun.errorMessage}</div>
							)}
						</div>

						<div className={styles.automationActions}>
							<button
								className={styles.buttonSecondary}
								type="button"
								onClick={() => void queueAutomationAction("probe")}
								disabled={automationBusy || Boolean(automationStatus?.activeRun)}
							>
								Check renderer
							</button>
							<button
								className={styles.buttonExport}
								type="button"
								onClick={() => void saveAutomationSettings()}
								disabled={automationBusy}
							>
								Save schedule
							</button>
							<button
								className={styles.buttonInstagram}
								type="button"
								onClick={() => void queueAutomationAction("publish")}
								disabled={
									automationBusy ||
									Boolean(automationStatus?.activeRun) ||
									!automationStatus?.capability?.supported
								}
							>
								Run now (real post)
							</button>
						</div>
						{automationMessage && (
							<div className={styles.automationMessage}>{automationMessage}</div>
						)}
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
										{generatedVideo.duration
											? `${formatVideoDuration(generatedVideo.duration)} • `
											: ""}
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

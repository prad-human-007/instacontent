"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./modi.module.css";

const FRAME_SRC = "/modi/modi-frame.png";
const INITIAL_FILL_TOP = 0;
const DRAIN_DURATION_MS = 6000;
const LINE_ALPHA_THRESHOLD = 24;
const FILL_COLOUR = [255, 181, 0] as const;

type Phase = "loading" | "ready" | "running" | "complete" | "error";
type ExportState = "idle" | "preparing" | "recording" | "converting" | "downloading";

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
	ctx.font = "700 68px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
	ctx.fillStyle = "#ffffff";
	ctx.textAlign = "center";
	const titleMainY = 100;
	ctx.fillText("PM Modi’s Term is", width / 2, titleMainY);

	// Title Sub: ${percentage}% Completed
	ctx.font = "800 84px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
	const pctText = `${percentage.toFixed(2)}%`;
	const compText = " Completed";

	const pctWidth = ctx.measureText(pctText).width;
	const compWidth = ctx.measureText(compText).width;
	const totalWidth = pctWidth + compWidth;
	const startX = width / 2 - totalWidth / 2;
	const titleSubY = 198;

	ctx.textAlign = "left";
	ctx.fillStyle = "#ffb500";
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
	const containerY = 320;
	const containerW = width - 2 * containerX; // 990px
	const containerH = height - containerY - 68; // 1532px

	const scale = Math.min(containerW / assets.width, containerH / assets.height);

	const dstW = assets.width * scale;
	const dstH = assets.height * scale;
	const dstX = containerX + (containerW - dstW) / 2;
	const dstY = containerY + (containerH - dstH) / 2;

	ctx.drawImage(portraitCanvas, dstX, dstY, dstW, dstH);
}

async function convertWebmToMp4(webmBlob: Blob): Promise<Blob> {
	const { FFmpeg } = await import("@ffmpeg/ffmpeg");
	const { fetchFile, toBlobURL } = await import("@ffmpeg/util");

	const ffmpeg = new FFmpeg();
	const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

	await ffmpeg.load({
		coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
		wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
	});

	const inputName = "input.webm";
	const outputName = "output.mp4";

	await ffmpeg.writeFile(inputName, await fetchFile(webmBlob));

	await ffmpeg.exec([
		"-i",
		inputName,
		"-c:v",
		"libx264",
		"-c:a",
		"aac",
		"-pix_fmt",
		"yuv420p",
		"-r",
		"30",
		"-movflags",
		"+faststart",
		outputName,
	]);

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
			return "Downloading…";
		default:
			return "Export MP4";
	}
}

export default function ModiDrain() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const assetsRef = useRef<RenderAssets | null>(null);
	const animationFrameRef = useRef<number | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

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

		paint(startLevel);
		setPercentage(0);

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			paint(targetLevel);
			setPercentage(completedPercentage);
			setPhase("complete");
			return;
		}

		const audio = new Audio(`/audio/${selectedAudio}`);
		audioRef.current = audio;

		const runAnimationWithDuration = (durationMs: number) => {
			audio.play().catch(() => {});
			setPhase("running");
			const startedAt = performance.now();

			const animate = (time: number) => {
				const progress = Math.min((time - startedAt) / durationMs, 1);
				const fillTop = startLevel + (targetLevel - startLevel) * progress;
				paint(fillTop);
				setPercentage(progress * completedPercentage);

				if (progress < 1) {
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
		if (exportState !== "idle" || phase === "loading" || phase === "error") return;

		setExportError(null);
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

			const AudioContextClass =
				window.AudioContext ||
				(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			audioCtx = new AudioContextClass();

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

			setExportState("recording");

			const recordStartTime = performance.now();
			sourceNode.start(0);
			mediaRecorder.start();

			await new Promise<void>((resolve) => {
				const animate = (now: number) => {
					const elapsedMs = now - recordStartTime;
					const progress = Math.min(elapsedMs / durationMs, 1);
					const fillTop = startLevel + (targetLevel - startLevel) * progress;
					const currentPct = progress * completedPercentage;

					drawOffscreenCard(ctx, fillTop, currentPct, assets, portraitCanvas);
					paint(fillTop);
					setPercentage(currentPct);

					if (progress < 1) {
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

			let finalMp4Blob: Blob;
			const isAlreadyH264Mp4 =
				rawBlob.type.includes("mp4") &&
				(rawBlob.type.includes("avc1") || rawBlob.type.includes("h264"));

			if (isAlreadyH264Mp4) {
				finalMp4Blob = rawBlob;
			} else {
				setExportState("converting");
				finalMp4Blob = await convertWebmToMp4(rawBlob);
			}

			setExportState("downloading");

			const sanitizedDate = (currentDate || getTodayString()).trim().replace(/[^a-zA-Z0-9-]/g, "-");
			const downloadFilename = `modi-term-progress-${sanitizedDate}.mp4`;

			const downloadUrl = URL.createObjectURL(finalMp4Blob);
			const a = document.createElement("a");
			a.href = downloadUrl;
			a.download = downloadFilename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);

			setTimeout(() => {
				URL.revokeObjectURL(downloadUrl);
			}, 10000);
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

	const isDisabled = phase === "running" || exportState !== "idle";

	return (
		<main className={styles.page}>
			<section className={styles.experience}>
				<div className={styles.portrait} aria-busy={phase === "loading" || exportState !== "idle"}>
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
							<span aria-hidden="true">⇩</span>
							{getExportLabel(exportState)}
						</button>
					</div>

					{exportError && <div className={styles.exportError}>{exportError}</div>}
				</div>
			</section>
		</main>
	);
}

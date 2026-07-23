"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./modi.module.css";

const FRAME_SRC = "/modi/modi-frame.png";
const INITIAL_FILL_TOP = 0;
const DRAIN_DURATION_MS = 6000;
const LINE_ALPHA_THRESHOLD = 24;
const FILL_COLOUR = [255, 181, 0] as const;

type Phase = "loading" | "ready" | "running" | "complete" | "error";

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

	// Match YYYY-MM-DD or YYYY/MM/DD
	const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
	if (ymdMatch) {
		const year = parseInt(ymdMatch[1], 10);
		const month = parseInt(ymdMatch[2], 10) - 1;
		const day = parseInt(ymdMatch[3], 10);
		const d = new Date(Date.UTC(year, month, day));
		return Number.isNaN(d.getTime()) ? null : d;
	}

	// Match DD/MM/YYYY or DD-MM-YYYY
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

export default function ModiDrain() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const assetsRef = useRef<RenderAssets | null>(null);
	const animationFrameRef = useRef<number | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	const [phase, setPhase] = useState<Phase>("loading");
	const [percentage, setPercentage] = useState<number>(100);

	const [startDate, setStartDate] = useState<string>(DEFAULT_START_DATE);
	const [currentDate, setCurrentDate] = useState<string>(getTodayString());
	const [endDate, setEndDate] = useState<string>(DEFAULT_END_DATE);
	const [isLoaded, setIsLoaded] = useState<boolean>(false);

	const [audioList, setAudioList] = useState<string[]>(["reelAudio1.mp3"]);
	const [selectedAudio, setSelectedAudio] = useState<string>("reelAudio1.mp3");

	useEffect(() => {
		fetch("/api/audio")
			.then((res) => res.json())
			.then((data) => {
				if (data?.audios && Array.isArray(data.audios) && data.audios.length > 0) {
					setAudioList(data.audios);
					setSelectedAudio((prev) => (data.audios.includes(prev) ? prev : data.audios[0]));
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
		if (!assets || phase === "loading" || phase === "running" || phase === "error") return;

		stopAudio();

		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = null;
		}

		const completedPercentage = calculateTargetPercentage(startDate, currentDate, endDate);
		const remainingPercentage = 100 - completedPercentage;

		const startLevel = assets.height * INITIAL_FILL_TOP;
		const targetLevel = assets.height * (completedPercentage / 100);

		paint(startLevel);
		setPercentage(0);

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			paint(targetLevel);
			setPercentage(remainingPercentage);
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
				setPercentage(progress * remainingPercentage);

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
				const duration = audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)
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
	}, [paint, phase, startDate, currentDate, endDate, selectedAudio, stopAudio]);


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

	return (
		<main className={styles.page}>
			<section className={styles.experience}>
				<div className={styles.portrait} aria-busy={phase === "loading"}>
					<div className={styles.header}>
						<h1 className={styles.titleMain}>PM Modi’s Term is</h1>
						<h2 className={styles.titleSub}>
							<span className={styles.percentText}>{percentage.toFixed(2)}%</span>
							<span>Remaining</span>
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
								disabled={phase === "running"}
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
								disabled={phase === "running"}
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
								disabled={phase === "running"}
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
								disabled={phase === "running"}
							/>
						</div>
					</div>


					<div className={styles.buttonGroup}>
						<button
							className={styles.button}
							type="button"
							onClick={startDrain}
							disabled={phase === "loading" || phase === "running" || phase === "error"}
						>
							<span aria-hidden="true">▶</span>
							Play
						</button>

						<button
							className={styles.buttonSecondary}
							type="button"
							onClick={resetPortrait}
							disabled={phase === "loading" || phase === "error"}
						>
							<span aria-hidden="true">↺</span>
							Reset
						</button>
					</div>
				</div>
			</section>
		</main>
	);
}



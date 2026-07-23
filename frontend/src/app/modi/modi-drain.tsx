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

export default function ModiDrain() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const assetsRef = useRef<RenderAssets | null>(null);
	const animationFrameRef = useRef<number | null>(null);
	const [phase, setPhase] = useState<Phase>("loading");
	const [percentage, setPercentage] = useState<number>(100);

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

		const currentPercent = Math.max(0, Math.min(100, ((assets.height - top) / assets.height) * 100));
		setPercentage(currentPercent);
	}, []);

	const resetPortrait = useCallback(() => {
		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = null;
		}
		const assets = assetsRef.current;
		if (assets) {
			paint(assets.height * INITIAL_FILL_TOP);
			setPhase("ready");
		}
	}, [paint]);

	const startDrain = useCallback(() => {
		const assets = assetsRef.current;
		if (!assets || phase === "loading" || phase === "running" || phase === "error") return;

		if (animationFrameRef.current !== null) {
			cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = null;
		}

		const startLevel = assets.height * INITIAL_FILL_TOP;
		paint(startLevel);

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			paint(assets.height);
			setPhase("complete");
			return;
		}

		setPhase("running");
		const startedAt = performance.now();

		const animate = (time: number) => {
			const progress = Math.min((time - startedAt) / DRAIN_DURATION_MS, 1);
			const fillTop = startLevel + (assets.height - startLevel) * progress;
			paint(fillTop);

			if (progress < 1) {
				animationFrameRef.current = requestAnimationFrame(animate);
				return;
			}

			animationFrameRef.current = null;
			setPhase("complete");
		};

		animationFrameRef.current = requestAnimationFrame(animate);
	}, [paint, phase]);

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
				setPhase("ready");
			} catch {
				if (!cancelled) setPhase("error");
			}
		};

		void loadFrame();

		return () => {
			cancelled = true;
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current);
			}
		};
	}, [paint]);

	return (
		<main className={styles.page}>
			<section className={styles.experience}>
				<div className={styles.portrait} aria-busy={phase === "loading"}>
					<div className={styles.header}>
						<h1 className={styles.titleMain}>PM Modi Term is</h1>
						<h2 className={styles.titleSub}>
							<span className={styles.percentText}>{percentage.toFixed(2)}%</span>
							<span>Complete</span>
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
			</section>
		</main>
	);
}



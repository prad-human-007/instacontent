import type { Metadata } from "next";
import ModiDrain from "./modi-drain";

export const metadata: Metadata = {
	title: "Modi Colour Drain",
	description: "An interactive colour-drain portrait.",
};

export default function ModiPage() {
	return <ModiDrain />;
}

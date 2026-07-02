import type { ChangeEvent } from "react";

import type { MoonCG } from "../../types/mooncg";
import { useReplicant } from "./hooks";

export function MixerPage() {
	const bundlesWithSounds = window.__renderData__.bundles.filter(
		(bundle) => bundle.soundCues && bundle.soundCues.length > 0,
	);

	return (
		<div className="mixer-page" data-testid="mixer">
			<div className="ncg-card mixer-master-card">
				<VolumeFader label="Master Fader" name="volume:master" />
			</div>

			{bundlesWithSounds.map((bundle) => (
				<BundleSounds key={bundle.name} bundleName={bundle.name} />
			))}
		</div>
	);
}

function VolumeFader({ label, name }: { label: string; name: string }) {
	const { value, replicant } = useReplicant<number>(name, "_sounds");

	const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
		replicant.value = Number(event.target.value);
	};

	return (
		<div className="fader-row" data-testid={`fader-${name}`}>
			<span className="fader-label">{label}</span>
			<Fader value={value ?? 0} onChange={handleChange} />
		</div>
	);
}

function Fader({
	value,
	onChange,
}: {
	value: number;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
	return (
		<div className="fader">
			<input
				type="range"
				min={0}
				max={100}
				step={1}
				value={value}
				onChange={onChange}
			/>
			<input
				type="number"
				min={0}
				max={100}
				step={1}
				value={value}
				onChange={onChange}
			/>
		</div>
	);
}

function BundleSounds({ bundleName }: { bundleName: string }) {
	const { value: cues, replicant: cuesReplicant } = useReplicant<
		MoonCG.SoundCue[]
	>("soundCues", bundleName);

	const { value: soundFiles } = useReplicant<MoonCG.AssetFile[]>(
		"assets:sounds",
		bundleName,
	);

	// Mutations must go through the replicant's proxied value so that they are
	// translated into replicant operations.
	const mutateCue = (
		cueName: string,
		mutate: (cue: MoonCG.SoundCue) => void,
	) => {
		if (cuesReplicant.status !== "declared") {
			return;
		}

		const cue = cuesReplicant.value?.find((c) => c.name === cueName);
		if (cue) {
			mutate(cue);
		}
	};

	return (
		<div className="ncg-card" data-bundle-name={bundleName}>
			<div className="card-heading">{bundleName}</div>
			<div className="sound-cues">
				<VolumeFader label="Bundle Fader" name={`volume:${bundleName}`} />
				{(cues ?? []).map((cue) => (
					<SoundCueRow
						key={cue.name}
						cue={cue}
						soundFiles={soundFiles ?? []}
						onVolumeChange={(volume) => {
							mutateCue(cue.name, (target) => {
								target.volume = volume;
							});
						}}
						onFileChange={(file) => {
							mutateCue(cue.name, (target) => {
								target.file = file;
							});
						}}
					/>
				))}
			</div>
		</div>
	);
}

function SoundCueRow({
	cue,
	soundFiles,
	onVolumeChange,
	onFileChange,
}: {
	cue: MoonCG.SoundCue;
	soundFiles: MoonCG.AssetFile[];
	onVolumeChange: (volume: number) => void;
	onFileChange: (file: MoonCG.CueFile | undefined) => void;
}) {
	const selectValue = cue.file
		? cue.file.default
			? "default"
			: cue.file.base
		: "none";

	const handleFileSelect = (event: ChangeEvent<HTMLSelectElement>) => {
		const selected = event.target.value;
		if (selected === "none") {
			onFileChange(undefined);
		} else if (selected === "default") {
			onFileChange(cue.defaultFile);
		} else {
			const file = soundFiles.find((f) => f.base === selected);
			if (file) {
				onFileChange({
					sum: file.sum,
					base: file.base,
					ext: file.ext,
					name: file.name,
					url: file.url,
					default: false,
				});
			}
		}
	};

	return (
		<div className="sound-cue" data-testid={`sound-cue-${cue.name}`}>
			<span className="sound-cue-name">{cue.name}</span>

			{cue.assignable && (
				<select value={selectValue} onChange={handleFileSelect}>
					<option value="none">None</option>
					{cue.defaultFile && <option value="default">Default</option>}
					{soundFiles.map((file) => (
						<option key={file.base} value={file.base}>
							{file.base}
						</option>
					))}
				</select>
			)}

			<Fader
				value={cue.volume}
				onChange={(event) => {
					onVolumeChange(Number(event.target.value));
				}}
			/>
		</div>
	);
}

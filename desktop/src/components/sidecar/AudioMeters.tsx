import { MeterBar } from '../ui/MeterBar';

export function AudioMeters({ mic, system, mixed }: { mic: number; system: number; mixed: number }) {
  return (
    <>
      <MeterBar label="Mic" value={mic} />
      <MeterBar label="Sys" value={system} />
      <MeterBar label="Mix" value={mixed} />
    </>
  );
}

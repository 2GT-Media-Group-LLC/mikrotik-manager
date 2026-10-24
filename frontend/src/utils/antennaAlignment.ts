import type { AlignmentPeer, AlignmentSnapshot } from '../types/antennaAlignment';
import type { Device } from '../types';

export const ALIGNMENT_HOLD_MS = 3000;

export function canAlignAntenna(device: Pick<Device, 'device_type' | 'ssh_only'>): boolean {
  return device.device_type === 'wisp' && !device.ssh_only;
}

export interface AlignmentSelection { radio: string; peer: string }
export const alignmentPeerKey = (peer: AlignmentPeer) => peer.mac_address ?? 'monitor';

/** Only a single choice is automatic; once picked it survives a link dropout. */
export function initialAlignmentSelection(snapshot: AlignmentSnapshot, selection: AlignmentSelection): AlignmentSelection {
  const radioKey = selection.radio || (snapshot.radios.length === 1 ? snapshot.radios[0].key : '');
  const radio = snapshot.radios.find(r => r.key === radioKey);
  const peerKey = selection.peer || (radio?.peers.length === 1 ? alignmentPeerKey(radio.peers[0]) : '');
  return { radio: radioKey, peer: peerKey };
}

export function weakestAlignmentSignal(signals: (number | null)[]): number | null {
  if (!signals.length || signals.some(n => n === null || !Number.isFinite(n))) return null;
  return Math.min(...signals as number[]);
}

export function alignmentSampleFresh(receivedAt: number, now: number): boolean {
  return receivedAt > 0 && now >= receivedAt && now - receivedAt <= ALIGNMENT_HOLD_MS;
}

export interface AlignmentPoint { time: number; a: number | null; b: number | null; weakest: number | null }
export interface AlignmentHistory { points: AlignmentPoint[]; best: number | null }

/** Bound chart memory while keeping the best value for the entire session. */
export function appendAlignmentPoint(history: AlignmentHistory, point: AlignmentPoint): AlignmentHistory {
  if (history.points[history.points.length - 1]?.time === point.time) return history;
  return {
    points: [...history.points.slice(-239), point],
    best: point.weakest === null ? history.best : Math.max(history.best ?? -Infinity, point.weakest),
  };
}

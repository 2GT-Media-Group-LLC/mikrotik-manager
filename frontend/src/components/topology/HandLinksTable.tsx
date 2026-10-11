import type { HandLink, HandLinkEnd } from '../../types';
import { endId, type GraphOutput } from '../../utils/topologyGraph';

/** Every link drawn by hand, each removable, in case it's hard to click on the map (#147). */
export default function HandLinksTable({ links, graph, canWrite, onRemove }: {
  links: HandLink[];
  graph: GraphOutput | null;
  canWrite: boolean;
  onRemove: (id: number) => void;
}) {
  const name = (end: HandLinkEnd) => {
    const n = graph?.nodes.find((x) => x.id === endId(end));
    return String(n?.data.name ?? end.name ?? end.ref);
  };
  const kind = (end: HandLinkEnd) => (end.kind === 'device' ? 'device' : end.kind === 'node' ? 'your node' : 'neighbour');
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Links drawn by hand ({links.length})</h3>
      </div>
      <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
            {links.map((l) => (
              <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                <td className="px-4 py-2 text-gray-900 dark:text-white">{name(l.a)} <span className="text-xs text-gray-400">{kind(l.a)}</span></td>
                <td className="px-2 py-2 text-gray-400">↔</td>
                <td className="px-4 py-2 text-gray-900 dark:text-white">{name(l.b)} <span className="text-xs text-gray-400">{kind(l.b)}</span></td>
                <td className="px-4 py-2 text-xs text-gray-500">{l.label}</td>
                <td className="px-4 py-2 text-right">
                  {canWrite && <button className="text-xs text-red-600 hover:underline" onClick={() => onRemove(l.id)}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


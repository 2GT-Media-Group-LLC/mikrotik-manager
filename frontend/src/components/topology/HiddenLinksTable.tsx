/** Discovered links hidden by hand, each one showable again (discussion #85). */
export default function HiddenLinksTable({ links, canWrite, onShow }: {
  links: { key: string; label: string | null; hiddenAt: string; hiddenBy: string | null }[];
  canWrite: boolean;
  onShow: (key: string) => void;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Links hidden by hand ({links.length})</h3>
        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Discovered links someone marked as not a real cable. They stay hidden as discovery runs.</p>
      </div>
      <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
            {links.map((l) => (
              <tr key={l.key} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                <td className="px-4 py-2 text-gray-900 dark:text-white">{l.label || l.key}</td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {l.hiddenBy ? `${l.hiddenBy}, ` : ''}{new Date(l.hiddenAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-2 text-right">
                  {canWrite && <button className="text-xs text-blue-600 hover:underline" onClick={() => onShow(l.key)}>Show again</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

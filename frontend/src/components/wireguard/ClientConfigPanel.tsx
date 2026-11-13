import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Download, Copy, Check } from 'lucide-react';

interface Props {
  conf: string;
  fileName: string;
}

/** Side-by-side .conf text and QR for a WireGuard client — shown right after
 * a peer is created, or from its "View" action when the router still has
 * the private key it was created with. */
export default function ClientConfigPanel({ conf, fileName }: Props) {
  const [copied, setCopied] = useState(false);

  // Dependency-free QR generation: 0 = let the library pick the smallest type
  // that fits, 'M' balances scan reliability against QR size for a config
  // this long. scalable: true gives a viewBox so it fills its CSS box.
  const qrSvg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(conf);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [conf]);

  const copy = () => {
    navigator.clipboard.writeText(conf).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([conf], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col sm:flex-row gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Client config (.conf)</span>
          <div className="flex gap-2">
            <button onClick={copy} title="Copy" className="p-1 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">
              {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button onClick={download} title="Download" className="p-1 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">{conf}</pre>
      </div>
      <div className="flex flex-col items-center shrink-0">
        <span className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Client QR</span>
        <div
          className="w-[180px] h-[180px] rounded-lg border border-gray-200 dark:border-slate-700 bg-white p-1 [&_svg]:w-full [&_svg]:h-full"
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />
      </div>
    </div>
  );
}

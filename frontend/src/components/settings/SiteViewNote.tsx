/** Says a list shows only the sites in view, when that hides some of it. */
export default function SiteViewNote({ label, hidden, noun }: { label: string | null; hidden: number; noun: string }) {
  if (hidden === 0) return null;
  return (
    <p className="px-4 py-2 text-[11px] text-gray-400 dark:text-slate-500 border-t border-gray-100 dark:border-slate-700">
      Showing {noun} for {label ?? 'the sites in view'} and fleet-wide ones. {hidden} in other sites{' '}
      {hidden === 1 ? 'is' : 'are'} hidden; switch the site selector to all sites to see {hidden === 1 ? 'it' : 'them'}.
    </p>
  );
}

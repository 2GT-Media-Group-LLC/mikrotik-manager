/** A device's tags as small coloured chips, the same everywhere they appear. */
export interface TagLike { id: number; name: string; color: string }

export default function TagChips({ tags }: { tags?: TagLike[] | null }) {
  if (!tags?.length) return null;
  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="text-[10px] px-[5px] py-[1px] rounded-full font-medium whitespace-nowrap"
          style={{ background: tag.color + '33', color: tag.color, border: `1px solid ${tag.color}55` }}
        >
          {tag.name}
        </span>
      ))}
    </>
  );
}

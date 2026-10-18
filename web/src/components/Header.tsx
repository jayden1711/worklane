import type { ReactNode } from 'react';
import { GroupTabRow, MenuButton } from '../App';

/** A page's header bar: its title, a line under it, and its actions; the menu button on a narrow screen; under it, the tabs of the page's sidebar group (#585). */
export function Header({ title, children, sub }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-line bg-page/90 px-6 backdrop-blur max-md:gap-2 max-md:px-4">
        <MenuButton />
        <h1 className="text-[14px] font-semibold tracking-tight text-ink" data-testid="page-title">{title}</h1>
        {sub && <span className="truncate text-[12.5px] text-ink-3 max-md:hidden">{sub}</span>}
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </header>
      <GroupTabRow />
      {/* On a phone the line under the title is whole, under the bar, rather than cut short in it. */}
      {sub && <p className="px-6 pt-3 text-[12.5px] text-ink-3 md:hidden">{sub}</p>}
    </>
  );
}

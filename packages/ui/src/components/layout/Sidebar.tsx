import React from 'react';
import { RiInformationLine, RiQuestionLine, RiSettings3Line } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useUIStore } from '@/stores/useUIStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export const SIDEBAR_CONTENT_WIDTH = 250;
const SIDEBAR_MIN_WIDTH = 250;
const SIDEBAR_MAX_WIDTH = 500;

interface SidebarProps {
    isOpen: boolean;
    isMobile: boolean;
    children: React.ReactNode;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, isMobile, children }) => {
    const { sidebarWidth, setSidebarWidth, setSettingsDialogOpen, setAboutDialogOpen, toggleHelpDialog } = useUIStore();
    const [isResizing, setIsResizing] = React.useState(false);
    const startXRef = React.useRef(0);
    const startWidthRef = React.useRef(sidebarWidth || SIDEBAR_CONTENT_WIDTH);
    const resizingWidthRef = React.useRef<number | null>(null);
    const activeResizePointerIDRef = React.useRef<number | null>(null);
    const sidebarRef = React.useRef<HTMLElement | null>(null);

    const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
        if (typeof window === 'undefined') {
            return false;
        }
        return Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__);
    });

    React.useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }
        setIsDesktopApp(Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__));
    }, []);

    const clampSidebarWidth = React.useCallback((value: number) => {
        return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
    }, []);

    const applyLiveWidth = React.useCallback((nextWidth: number) => {
        const sidebar = sidebarRef.current;
        if (!sidebar) {
            return;
        }

        sidebar.style.setProperty('--oc-left-sidebar-width', `${nextWidth}px`);
    }, []);

    React.useEffect(() => {
        if (isMobile && isResizing) {
            setIsResizing(false);
        }
    }, [isMobile, isResizing]);

    React.useEffect(() => {
        if (!isResizing) {
            resizingWidthRef.current = null;
            activeResizePointerIDRef.current = null;
        }
    }, [isResizing]);

    if (isMobile) {
        return null;
    }

    const appliedWidth = isOpen ? Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth || SIDEBAR_CONTENT_WIDTH)
    ) : 0;

    const handlePointerDown = (event: React.PointerEvent) => {
        if (!isOpen) {
            return;
        }

        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // ignore
        }

        activeResizePointerIDRef.current = event.pointerId;
        setIsResizing(true);
        startXRef.current = event.clientX;
        startWidthRef.current = appliedWidth;
        resizingWidthRef.current = appliedWidth;
        applyLiveWidth(appliedWidth);
        event.preventDefault();
    };

    const handlePointerMove = (event: React.PointerEvent) => {
        if (isMobile || !isResizing || activeResizePointerIDRef.current !== event.pointerId) {
            return;
        }

        const delta = event.clientX - startXRef.current;
        const nextWidth = clampSidebarWidth(startWidthRef.current + delta);
        if (resizingWidthRef.current === nextWidth) {
            return;
        }

        resizingWidthRef.current = nextWidth;
        applyLiveWidth(nextWidth);
    };

    const handlePointerEnd = (event: React.PointerEvent) => {
        if (activeResizePointerIDRef.current !== event.pointerId || isMobile) {
            return;
        }

        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // ignore
        }

        const finalWidth = clampSidebarWidth(resizingWidthRef.current ?? appliedWidth);
        activeResizePointerIDRef.current = null;
        resizingWidthRef.current = null;
        setIsResizing(false);
        setSidebarWidth(finalWidth);
    };

    return (
        <aside
            ref={sidebarRef}
            className={cn(
                'relative flex h-full overflow-hidden border-r border-border/40',
                'bg-sidebar/50',
                isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-in-out',
                !isOpen && 'border-r-0'
            )}
            style={{
                width: 'var(--oc-left-sidebar-width)',
                minWidth: 'var(--oc-left-sidebar-width)',
                maxWidth: 'var(--oc-left-sidebar-width)',
                ['--oc-left-sidebar-width' as string]: `${isResizing ? (resizingWidthRef.current ?? appliedWidth) : appliedWidth}px`,
                overflowX: 'clip',
            }}
            aria-hidden={!isOpen || appliedWidth === 0}
        >
            {isOpen && (
                <div
                    className={cn(
                        'absolute right-0 top-0 z-20 h-full w-[4px] cursor-col-resize hover:bg-primary/50 transition-colors',
                        isResizing && 'bg-primary'
                    )}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerEnd}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize left panel"
                />
            )}
            <div
                className={cn(
                    'relative z-10 flex h-full flex-col transition-opacity duration-300 ease-in-out',
                    isResizing && 'pointer-events-none',
                    !isOpen && 'pointer-events-none select-none opacity-0'
                )}
                style={{ width: 'var(--oc-left-sidebar-width)', overflowX: 'hidden' }}
                aria-hidden={!isOpen}
            >
                <div className="flex-1 overflow-hidden">
                    <ErrorBoundary>{children}</ErrorBoundary>
                </div>
                <div className="flex-shrink-0 border-t border-border h-12 px-2 bg-sidebar">
                    <div className="flex h-full items-center justify-between gap-2">
                        <button
                            onClick={() => setSettingsDialogOpen(true)}
                            className={cn(
                                'flex h-8 items-center gap-2 rounded-md px-2',
                                'text-sm font-semibold text-sidebar-foreground/90',
                                'hover:text-sidebar-foreground hover:bg-interactive-hover',
                                'transition-all duration-200'
                            )}
                        >
                            <RiSettings3Line className="h-4 w-4" />
                            <span>Settings</span>
                        </button>
                        <div className="flex items-center gap-1">
                            {!isDesktopApp && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => setAboutDialogOpen(true)}
                                            className={cn(
                                                'flex h-8 w-8 items-center justify-center rounded-md',
                                                'text-sidebar-foreground/70',
                                                'hover:text-sidebar-foreground hover:bg-interactive-hover',
                                                'transition-all duration-200'
                                            )}
                                        >
                                            <RiInformationLine className="h-4 w-4" />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">About OpenChamber</TooltipContent>
                                </Tooltip>
                            )}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        onClick={toggleHelpDialog}
                                        className={cn(
                                            'flex h-8 w-8 items-center justify-center rounded-md',
                                            'text-sidebar-foreground/70',
                                            'hover:text-sidebar-foreground hover:bg-interactive-hover',
                                            'transition-all duration-200'
                                        )}
                                        aria-label="Keyboard shortcuts"
                                    >
                                        <RiQuestionLine className="h-4 w-4" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="top">Keyboard shortcuts</TooltipContent>
                            </Tooltip>
                        </div>
                    </div>
                </div>
            </div>
        </aside>
    );
};

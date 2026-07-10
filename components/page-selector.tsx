"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PageSelectorProps = {
  currentPage: number;
  pageCount: number;
  loading?: boolean;
  pageSize?: number;
  pageSizeOptions?: number[];
  totalRecords?: number;
  className?: string;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

function paginationRange(currentPage: number, pageCount: number) {
  const pages = new Set<number>([1, pageCount]);
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(pageCount, currentPage + 2);

  for (let page = start; page <= end; page += 1) {
    pages.add(page);
  }

  return [...pages].sort((a, b) => a - b);
}

export function PageSelector({
  currentPage,
  pageCount,
  loading = false,
  pageSize,
  pageSizeOptions = [],
  totalRecords,
  className,
  onPageChange,
  onPageSizeChange,
}: PageSelectorProps) {
  const safePageCount = Math.max(pageCount, 1);
  const safeCurrentPage = Math.min(Math.max(currentPage, 1), safePageCount);
  const pages = paginationRange(safeCurrentPage, safePageCount);

  return (
    <div className={cn("page-selector", className)}>
      <span className="page-selector-summary">
        第 {safeCurrentPage} / {safePageCount} 页
        {totalRecords !== undefined ? ` · ${totalRecords} 条` : ""}
      </span>
      <div className="page-selector-controls">
        <Button
          variant="outline"
          size="sm"
          disabled={safeCurrentPage <= 1 || loading}
          onClick={() => onPageChange?.(safeCurrentPage - 1)}
        >
          上一页
        </Button>
        <div className="page-selector-pages" aria-label="分页">
          {pages.map((page, index) => (
            <div className="page-selector-page-slot" key={page}>
              {index > 0 && page - pages[index - 1] > 1 && (
                <span className="page-selector-ellipsis">...</span>
              )}
              <Button
                variant={page === safeCurrentPage ? "default" : "outline"}
                size="sm"
                disabled={loading}
                aria-current={page === safeCurrentPage ? "page" : undefined}
                onClick={() => onPageChange?.(page)}
              >
                {page}
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={safeCurrentPage >= safePageCount || loading}
          onClick={() => onPageChange?.(safeCurrentPage + 1)}
        >
          下一页
        </Button>
        {pageSize !== undefined && onPageSizeChange && pageSizeOptions.length > 0 && (
          <select
            className="input page-size-select"
            value={pageSize}
            disabled={loading}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option} / 页
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

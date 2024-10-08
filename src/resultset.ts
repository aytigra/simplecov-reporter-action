import { z } from 'zod';
import { combineResults, nonNullable } from './helpers';
import * as Codeowners from 'codeowners';

const Lines = z.number().or(z.null()).array();

export type Lines = z.infer<typeof Lines>;

const BranchEntry = z.record(z.number());

export type BranchEntry = z.infer<typeof BranchEntry>;

const Branches = z.record(BranchEntry);

export type Branches = z.infer<typeof Branches>;

const Entry = z.object({
  lines: Lines,
  branches: Branches.optional(),
});

export type Entry = z.infer<typeof Entry>;

const Result = z.object({
  coverage: z.record(Entry),
  timestamp: z.number(),
});

export type Result = z.infer<typeof Result>;

export const ResultSet = z.record(Result);

export type ResultSet = z.infer<typeof ResultSet>;

interface LineStats {
  branches?: never;
  branchesCovered?: never;
  includesBranches: false;
  lines: number;
  linesCovered: number;
}

interface BranchStats {
  branches: number;
  branchesCovered: number;
  includesBranches: true;
  lines: number;
  linesCovered: number;
}

export type Stats = LineStats | BranchStats;

export interface Coverage {
  includesBranches: boolean;
  fileStats: Map<string, Stats>;
  totalStats: Stats;
}

const consolidate = (resultSet: ResultSet): Result => {
  const results = Object.values(resultSet);

  // ResultSet is empty
  if (results.length === 0) return { coverage: {}, timestamp: Date.now() };

  return results.reduce(combineResults);
};

const combineStats = (a: Stats | undefined, b: Stats | undefined): Stats => {
  const lineStats = {
    includesBranches: false as const,
    lines: (a?.lines ?? 0) + (b?.lines ?? 0),
    linesCovered: (a?.linesCovered ?? 0) + (b?.linesCovered ?? 0),
  };

  const branchStats =
    a?.includesBranches || b?.includesBranches
      ? {
          includesBranches: true as const,
          branches: (a?.branches ?? 0) + (b?.branches ?? 0),
          branchesCovered: (a?.branchesCovered ?? 0) + (b?.branchesCovered ?? 0),
        }
      : {};

  return { ...lineStats, ...branchStats };
};

export const toCoverage = (resultSet: ResultSet): Coverage => {
  const coverage = consolidate(resultSet).coverage;

  const entries = Object.entries(coverage).map(([path, counts]) => {
    const lineEntries = counts.lines.filter(nonNullable);
    const lines = lineEntries.length;
    const linesCovered = lineEntries.filter((count) => count > 0).length;

    const lineStats = { includesBranches: false as const, lines, linesCovered };

    const branchEntries = Object.values(counts.branches ?? {}).flatMap((entry) =>
      Object.values(entry),
    );
    const branchStats =
      counts.branches === undefined
        ? {}
        : {
            includesBranches: true as const,
            branches: branchEntries.length,
            branchesCovered: branchEntries.filter((count) => count > 0).length,
          };

    return [path, { ...lineStats, ...branchStats }] as const;
  });

  return {
    includesBranches: entries.some(([_, value]) => value.includesBranches),
    fileStats: new Map(entries),
    totalStats: entries.map(([, stats]) => stats).reduce(combineStats),
  };
};

const changed = (a: Stats | undefined, b: Stats | undefined) => {
  if (a === undefined && b === undefined) return false;
  if (a === undefined || b === undefined) return true;
  return (
    a.includesBranches !== b.includesBranches ||
    a.lines !== b.lines ||
    a.linesCovered !== b.linesCovered ||
    a.branches !== b.branches ||
    a.branchesCovered !== b.branchesCovered
  );
};

export interface StatsDiff {
  baseline: Stats | undefined;
  current: Stats;
}

interface FileDiff extends StatsDiff {
  filename: string;
}

interface OwnerDiff extends StatsDiff {
  ownerName: string;
}

export interface CoverageDiff {
  includesBranches: boolean;
  fileDiffs: FileDiff[];
  ownerDiffs: OwnerDiff[];
  totalDiff: StatsDiff;
}

export const diffCoverage = (
  baselineCoverage: Coverage,
  currentCoverage: Coverage,
  baseDir?: string,
): CoverageDiff | undefined => {
  const owners = new Codeowners(baseDir);

  const fileRegex = new RegExp(`^${baseDir}/?`);
  const includesBranches = baselineCoverage.includesBranches || currentCoverage.includesBranches;

  const filenames = [
    ...new Set([...baselineCoverage.fileStats.keys(), ...currentCoverage.fileStats.keys()]),
  ];
  filenames.sort();

  const fileDiffs: FileDiff[] = [];
  const ownerDiffMap: Map<string, OwnerDiff> = new Map();

  for (const file of filenames) {
    const filename = file.replace(fileRegex, '');
    const baseline = baselineCoverage.fileStats.get(file);
    const current = currentCoverage.fileStats.get(file);

    if (current != null && changed(baseline, current)) {
      fileDiffs.push({ filename, baseline, current });
    }

    const ownerNames = owners.getOwner(filename);
    for (const ownerName of ownerNames) {
      const prevDiff = ownerDiffMap.get(ownerName);

      ownerDiffMap.set(ownerName, { ownerName, baseline: combineStats(prevDiff?.baseline, baseline), current: combineStats(prevDiff?.current, current) });
    }
  }

  return {
    includesBranches,
    fileDiffs,
    ownerDiffs: Array.from(ownerDiffMap.values()),
    totalDiff: { baseline: baselineCoverage.totalStats, current: currentCoverage.totalStats },
  };
};

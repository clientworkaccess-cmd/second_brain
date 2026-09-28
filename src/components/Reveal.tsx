'use client';

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Entry motion, per Desing.md: fade + translate-Y 16px → 0, spring physics
 * (stiffness 120, damping 20), 120ms stagger between items in a list.
 * Only transform and opacity animate — nothing here triggers layout.
 */

const spring = { type: 'spring' as const, stiffness: 120, damping: 20 };

export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Cascades its children at 120ms intervals. */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial="hidden"
      animate="shown"
      variants={{ shown: { transition: { staggerChildren: 0.12 } } }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 16 }, shown: { opacity: 1, y: 0 } }}
      transition={spring}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Hover lift for interactive cards: scale 1.03 + shadow over 200ms. */
export function Lift({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      whileHover={{ scale: 1.03 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

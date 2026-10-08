/**
 * The shared UI primitives (0109).
 *
 * Every public marketplace surface is built from these, which is the mechanism by which the product looks like
 * one product rather than fourteen screens that were each styled on their own. {@link recipes} holds the visual
 * grammar the primitives compose from — the focus ring, the surfaces, the type scale, the radius-per-role rule —
 * and the applications import from it directly for the few one-off surfaces a primitive would be overkill for.
 *
 * Server-safe unless marked. `Dialog` and `Dropdown` are client components; everything else renders on the
 * server, which matters because every page in this product is `force-dynamic` and the less that ships to the
 * browser the faster a catalogue paints.
 */

/* the visual grammar */
export {
  cx,
  DISABLED,
  FOCUS_RING,
  FOCUS_RING_INVERTED,
  INTERACTIVE,
  LINK,
  SCRIM,
  SURFACE_CARD,
  SURFACE_OVERLAY,
  SURFACE_POPOVER,
  SURFACE_WELL,
  TYPE,
} from './recipes.js';

/* structure */
export { Heading, type HeadingProps } from './heading.js';
export { PageContainer, type PageContainerProps } from './page-container.js';
export { SkipLink, type SkipLinkProps } from './skip-link.js';
export {
  CardGrid,
  DetailLayout,
  DetailList,
  MetaRow,
  Section,
  SectionHeader,
  type SectionHeaderProps,
  type SectionProps,
} from './layout.js';

/* controls */
export {
  Button,
  ButtonLink,
  buttonClasses,
  type ButtonLinkProps,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './button.js';
export { Input, Textarea, fieldClasses, type InputProps, type InputType, type TextareaProps } from './input.js';
export { Select, type SelectOption, type SelectProps } from './select.js';
export { FormField, fieldAria, type FormFieldProps } from './form-field.js';
export { Choice, ChoiceGroup, type ChoiceProps } from './choice.js';
export { Spinner } from './spinner.js';

/* content */
export {
  Card,
  CardBody,
  CardFooter,
  CardOverlayLink,
  CardTitle,
  LinkCard,
  type CardProps,
  type CardTitleProps,
  type LinkCardProps,
} from './card.js';
export { Badge, type BadgeProps, type BadgeTone } from './badge.js';
export { Avatar, firstGrapheme, type AvatarProps, type AvatarSize } from './avatar.js';

/* navigation */
export { Breadcrumb, type BreadcrumbItem, type BreadcrumbProps } from './breadcrumb.js';
export { Pagination, type PaginationProps } from './pagination.js';
export { SegmentedLinks, TabPanel, Tabs, type TabItem, type TabsProps } from './tabs.js';

/* states */
export { Alert, type AlertProps, type AlertTone } from './alert.js';
export { EmptyLine, EmptyState, type EmptyStateProps, type EmptyTone } from './empty-state.js';
export { Skeleton, SkeletonCard, SkeletonCardGrid, SkeletonText } from './skeleton.js';

/* overlays — client components */
export { Dialog, type DialogPlacement, type DialogProps } from './dialog.js';
export {
  Dropdown,
  DropdownButton,
  DropdownGroup,
  DropdownLink,
  type DropdownProps,
} from './dropdown.js';

/**
 * Placeholder view for routes whose content is built in later tasks.
 *
 * Task 11 delivers the navigation shell and the default Summary landing view.
 * The remaining views are routed here so the persistent nav (Requirements 11.3,
 * 11.4) is fully navigable now without pre-empting or regressing the work in:
 *  - Task 12: Space_View
 *  - Task 13: Dashboard
 *  - Task 14: Graph_View
 *  - Task 15: Chat_UI
 *  - Task 16/17: Admin Context_Manager and Refresh control
 */
export function PlaceholderView({
  title,
  description,
}: {
  title: string;
  description: string;
}): JSX.Element {
  return (
    <section aria-labelledby="placeholder-heading">
      <h2 id="placeholder-heading" style={{ marginTop: 0 }}>
        {title}
      </h2>
      <p style={{ color: '#475467' }}>{description}</p>
      <p
        style={{
          marginTop: '1.5rem',
          padding: '1rem 1.25rem',
          border: '1px dashed #d0d5dd',
          borderRadius: 12,
          color: '#667085',
          background: '#fcfcfd',
        }}
      >
        This view is coming soon.
      </p>
    </section>
  );
}

import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        There is nothing at this address. <Link to="/">Go to your products</Link>.
      </p>
    </>
  );
}

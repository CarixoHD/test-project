import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  CreateProductRequestSchema,
  PRODUCT_IDEA_MAX,
  PRODUCT_NAME_MAX,
} from '../../../shared/dto.ts';
import { ApiError, createProduct } from '../../state/api.ts';
import { Button, Field } from '../../ui/index.ts';

type FieldName = 'name' | 'idea';
type FieldErrors = Partial<Record<FieldName, string>>;

/** State passed to the product page so it can say "opening" until the product event arrives. */
export interface CreatedLocationState {
  created: true;
}

/** Errors per field from the shared request schema (the server applies the same rules). */
function validate(name: string, idea: string): FieldErrors {
  const parsed = CreateProductRequestSchema.safeParse({ name, idea });
  const errors: FieldErrors = {};
  for (const issue of parsed.error?.issues ?? []) {
    const field = issue.path[0];
    if ((field === 'name' || field === 'idea') && errors[field] === undefined) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

/** The "New product" form: validates, POSTs /api/products and opens the new product's Spec tab. */
export function NewProductForm() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [idea, setIdea] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const ideaRef = useRef<HTMLTextAreaElement>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    const found = validate(name, idea);
    setErrors(found);
    setServerError(null);
    if (found.name !== undefined) return nameRef.current?.focus();
    if (found.idea !== undefined) return ideaRef.current?.focus();

    setSubmitting(true);
    try {
      const { id } = await createProduct({ name, idea });
      const state: CreatedLocationState = { created: true };
      // Story 2: a new product starts with sparring, which lives on the Spec tab.
      await navigate(`/products/${id}/spec`, { state });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not create the product.');
      setSubmitting(false);
    }
  }

  return (
    <form aria-labelledby="new-product-heading" noValidate onSubmit={(e) => void onSubmit(e)}>
      <h2 id="new-product-heading">New product</h2>
      <Field label="Name" error={errors.name ?? null}>
        {(control) => (
          <input
            {...control}
            ref={nameRef}
            name="name"
            type="text"
            autoComplete="off"
            maxLength={PRODUCT_NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Idea"
        hint="A few sentences about what you want to build."
        error={errors.idea ?? null}
      >
        {(control) => (
          <textarea
            {...control}
            ref={ideaRef}
            name="idea"
            rows={4}
            maxLength={PRODUCT_IDEA_MAX}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
          />
        )}
      </Field>
      {serverError !== null ? (
        <p role="alert" className="ui-field__error">
          {serverError}
        </p>
      ) : null}
      <Button type="submit" variant="primary" aria-disabled={isSubmitting || undefined}>
        {isSubmitting ? 'Creating…' : 'Create product'}
      </Button>
    </form>
  );
}

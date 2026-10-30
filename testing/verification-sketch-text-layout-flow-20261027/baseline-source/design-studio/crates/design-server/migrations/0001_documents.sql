CREATE TABLE design_documents (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    revision BIGINT NOT NULL CHECK (revision > 0),
    document JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE design_versions (
    document_id UUID NOT NULL REFERENCES design_documents(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    document JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, revision)
);
CREATE TABLE design_write_receipts (
    document_id UUID NOT NULL REFERENCES design_documents(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    digest BYTEA NOT NULL,
    revision BIGINT NOT NULL,
    PRIMARY KEY (document_id, request_id)
);

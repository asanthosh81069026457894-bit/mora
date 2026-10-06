CREATE TABLE public.voice_fragments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 call_id uuid NOT NULL,
 role text NOT NULL CHECK (role IN ('user','assistant')),
 content text NOT NULL,
 start_ms double precision NOT NULL DEFAULT 0,
 end_ms double precision NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.voice_fragments TO authenticated;
GRANT ALL ON public.voice_fragments TO service_role;
ALTER TABLE public.voice_fragments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read own conversation" ON public.voice_fragments FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Save own conversation" ON public.voice_fragments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE INDEX voice_fragments_user_time ON public.voice_fragments (user_id, created_at);
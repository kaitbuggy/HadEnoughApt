-- Bedroom size review: lets the Review page confirm or correct the bedroom sizes
-- read from each plan image ("Will my bed fit?"). Run once in the Supabase SQL editor.

insert into attribute_defs (key, label, applies_to, value_type)
values ('bedroom_sizes', 'Bedroom sizes', 'floor_plan', 'text')
on conflict (key) do nothing;

drop policy if exists labels_open_bedroom_review on labels;
create policy labels_open_bedroom_review on labels for insert to anon, authenticated
  with check (
    source = 'user' and status in ('accepted','corrected')
    and attribute_key = 'bedroom_sizes'
    and floor_plan_id is not null and building_id is null and unit_id is null
    and model_name is null and confidence is null and reviewed_by is null and reviewed_at is null
    and coalesce(length(evidence), 0) <= 280
    and jsonb_typeof(value) = 'object'
    and jsonb_typeof(value -> 'shown') = 'boolean'
    and jsonb_typeof(value -> 'rooms') = 'array'
    and jsonb_array_length(value -> 'rooms') <= 4
    and length(value::text) <= 600
  );

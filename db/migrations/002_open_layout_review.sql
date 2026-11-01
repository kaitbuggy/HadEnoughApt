-- Open layout review (no sign-in needed), with guard rails.
-- Anyone using the website can ADD a layout answer for a floor plan. Nobody can
-- edit or delete rows through the website, and every answer is kept, so a bad
-- answer can be undone by deleting that row (or reverted in bulk by time).
-- Only these four answers are accepted, with valid values:
--   kitchen_shape: "u_shape" | "l_shape" | "galley" | "single_wall" | null (not sure)
--   kitchen_island, walk_in_shower, has_tub: true | false | null (not sure)
-- Run once in the Supabase SQL editor.

do $$
declare seq text := pg_get_serial_sequence('labels', 'id');
begin
  execute format('grant usage on sequence %s to anon, authenticated', seq);
end $$;
grant insert on labels to anon, authenticated;

drop policy if exists labels_open_review on labels;
create policy labels_open_review on labels for insert to anon, authenticated
  with check (
    source = 'user'
    and status in ('accepted', 'corrected')
    and floor_plan_id is not null and building_id is null and unit_id is null
    and model_name is null and confidence is null and reviewed_by is null and reviewed_at is null
    and attribute_key in ('kitchen_shape', 'kitchen_island', 'walk_in_shower', 'has_tub')
    and (
      (attribute_key = 'kitchen_shape' and (value = 'null'::jsonb or value #>> '{}' in ('u_shape', 'l_shape', 'galley', 'single_wall')))
      or (attribute_key <> 'kitchen_shape' and jsonb_typeof(value) in ('boolean', 'null'))
    )
    and coalesce(length(evidence), 0) <= 280
  );

-- To undo answers saved in a time window:
--   delete from labels where source = 'user' and created_at between '...' and '...';

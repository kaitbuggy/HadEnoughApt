-- Unit facing review: anyone can say which way a unit's windows face.
-- Run once in the Supabase SQL editor. Safe to run again.

insert into attribute_defs (key, label, applies_to, value_type, enum_values) values
  ('view_of', 'Windows face',  'unit', 'enum', array['courtyard','street','park','pool','building']),
  ('facing',  'Direction',     'unit', 'enum', array['N','E','S','W'])
on conflict (key) do nothing;

-- Insert-only, like the layout review (002): unit-level answers with valid values.
drop policy if exists labels_open_unit_review on labels;
create policy labels_open_unit_review on labels for insert to anon, authenticated
  with check (
    source = 'user' and status = 'accepted'
    and unit_id is not null and building_id is null and floor_plan_id is null
    and model_name is null and confidence is null and reviewed_by is null and reviewed_at is null
    and coalesce(length(evidence), 0) <= 280
    and (
      (attribute_key = 'view_of' and (value = 'null'::jsonb or value #>> '{}' in ('courtyard','street','park','pool','building')))
      or (attribute_key = 'facing' and value #>> '{}' in ('N','E','S','W'))
    )
  );

-- Undo a bad batch: delete from labels where source = 'user' and unit_id is not null and created_at between '…' and '…';

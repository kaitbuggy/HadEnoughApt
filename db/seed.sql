-- Starter data: screening attributes + example Austin buildings.

insert into attribute_defs (key, label, applies_to, value_type, enum_values) values
  ('kitchen_shape',   'Kitchen shape',             'floor_plan', 'enum',    array['u_shape','l_shape','galley','single_wall','island','peninsula']),
  ('walk_in_shower',  'Walk-in shower',            'floor_plan', 'boolean', null),
  ('separate_tub',    'Separate tub',              'floor_plan', 'boolean', null),
  ('ada',             'ADA unit (lower counters)', 'floor_plan', 'boolean', null),
  ('bedroom_door',    'Bedroom has a door',        'floor_plan', 'boolean', null),
  ('bedroom_window_wall', 'Bedroom windows (darker = fewer)', 'floor_plan', 'number', null),
  ('den',             'Den / study',               'floor_plan', 'boolean', null),
  ('ac_type',         'AC type',                   'building',   'enum',    array['central','split','wall_unit','floor_unit','ports_only','none']),
  ('gas_stove',       'Gas stove',                 'building',   'boolean', null),
  ('flooring',        'Flooring',                  'floor_plan', 'enum',    array['hard','carpet_bedroom','carpet_all']),
  ('washer_dryer',    'In-unit washer/dryer',      'building',   'boolean', null);

insert into buildings (name, address, website_url, availability_url, sightmap_url, platform, year_built, notes) values
  ('Griffis at The Domain', null,
   'https://griffisresidential.com/property/the-domain',
   'https://griffisresidential.com/property/the-domain/pricing-availability/',
   'https://sightmap.com/embed/60p7krjnw7n',
   'griffis-engrain', null,
   'Top-floor units face the park. Site lists unavailable plans too, so plan history is trackable.'),
  ('Solaris House at Uptown ATX', '2800 Solaris St, Austin, TX',
   'https://www.solarishouseapartments.com/', null, null, 'rentcafe', 2024,
   'New building.'),
  ('The Grand at the Domain', '11009 Alterra Pkwy, Austin, TX',
   'https://thegrandatdomain.com/', null, null, 'unknown', 2019, null),
  ('The Watson', '11901 Burnet Rd, Austin, TX 78758',
   'https://www.thewatson.com/austin/the-watson/conventional/',
   'https://sightmap.com/embed/x1p8jg4rvd6',
   'https://sightmap.com/embed/x1p8jg4rvd6',
   'sightmap', null,
   'New building. Plan codes like A1.1, B2.3; "WF" suffix = workforce housing.');

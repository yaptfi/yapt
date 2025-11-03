exports.up = (pgm) => {
  // Drop old check constraints
  pgm.dropConstraint('notification_settings', 'notification_settings_depeg_severity_check');
  pgm.dropConstraint('notification_settings', 'notification_settings_apy_severity_check');
  pgm.dropConstraint('notification_log', 'notification_log_severity_check');

  // Update existing data FIRST: change 'medium' to 'default'
  pgm.sql(`
    UPDATE notification_settings
    SET depeg_severity = 'default'
    WHERE depeg_severity = 'medium'
  `);

  pgm.sql(`
    UPDATE notification_settings
    SET apy_severity = 'default'
    WHERE apy_severity = 'medium'
  `);

  pgm.sql(`
    UPDATE notification_log
    SET severity = 'default'
    WHERE severity = 'medium'
  `);

  // THEN add new check constraints with updated severity levels
  pgm.addConstraint('notification_settings', 'notification_settings_depeg_severity_check', {
    check: "depeg_severity IN ('min', 'low', 'default', 'high', 'urgent')",
  });

  pgm.addConstraint('notification_settings', 'notification_settings_apy_severity_check', {
    check: "apy_severity IN ('min', 'low', 'default', 'high', 'urgent')",
  });

  pgm.addConstraint('notification_log', 'notification_log_severity_check', {
    check: "severity IN ('min', 'low', 'default', 'high', 'urgent')",
  });
};

exports.down = (pgm) => {
  // Revert to old constraints
  pgm.dropConstraint('notification_settings', 'notification_settings_depeg_severity_check');
  pgm.dropConstraint('notification_settings', 'notification_settings_apy_severity_check');
  pgm.dropConstraint('notification_log', 'notification_log_severity_check');

  pgm.addConstraint('notification_settings', 'notification_settings_depeg_severity_check', {
    check: "depeg_severity IN ('low', 'medium', 'high', 'urgent')",
  });

  pgm.addConstraint('notification_settings', 'notification_settings_apy_severity_check', {
    check: "apy_severity IN ('low', 'medium', 'high', 'urgent')",
  });

  pgm.addConstraint('notification_log', 'notification_log_severity_check', {
    check: "severity IN ('low', 'medium', 'high', 'urgent')",
  });

  // Revert data
  pgm.sql(`
    UPDATE notification_settings
    SET depeg_severity = 'medium'
    WHERE depeg_severity = 'default'
  `);

  pgm.sql(`
    UPDATE notification_settings
    SET apy_severity = 'medium'
    WHERE apy_severity = 'default'
  `);

  pgm.sql(`
    UPDATE notification_log
    SET severity = 'medium'
    WHERE severity = 'default'
  `);
};

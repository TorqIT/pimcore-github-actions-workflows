#!/usr/bin/env bash

until nc -z -v -w30 $DATABASE_HOST 3306
do
  echo "Waiting for database connection..."
  sleep 5
done

echo Installing Pimcore...
runuser -u www-data -- /var/www/html/vendor/bin/pimcore-install \
  --admin-username=test \
  --admin-password=test \
  --mysql-host-socket=$DATABASE_HOST \
  --mysql-database=$DATABASE_NAME \
  --mysql-username=$DATABASE_USER \
  --mysql-password=$DATABASE_PASSWORD \
  --ignore-existing-config

echo Rebuilding classes...
runuser -u www-data -- /var/www/html/bin/console pimcore:deployment:classes-rebuild -c -d -n

echo Running tests...
runuser -u www-data -- /var/www/html/vendor/bin/phpunit --testdox test

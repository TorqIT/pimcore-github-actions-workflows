<?php

declare(strict_types=1);

use PhpCsFixer\Fixer\Import\NoUnusedImportsFixer;
use Symplify\EasyCodingStandard\Config\ECSConfig;

return ECSConfig::configure()
    ->withPaths([
        __DIR__ . '/config',
        __DIR__ . '/public',
        __DIR__ . '/src',
        __DIR__ . '/test',
    ])

    // add a single rule
    ->withRules([
        NoUnusedImportsFixer::class,
        // SingleLineAfterImportsFixer::class,
        // ArraySyntaxFixer::class,
        // YodaStyleFixer::class,

    ])

    // add sets - group of rules
    //    ->withPreparedSets(
    // arrays: true,
    // namespaces: true,
    // spaces: true,
    // docblocks: true,
    // comments: true,
    //    )

;
